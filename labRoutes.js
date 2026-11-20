const express = require('express');
const { labDb, seedDemoProducts } = require('./labDb');

const labRouter = express.Router();

/**
 * แปลงข้อความที่สแกนได้จาก QR Code / Barcode ให้เป็นรหัสมาตรฐาน
 * รองรับทั้ง:
 *  - รหัสตรงๆ เช่น "SM-NP-001" หรือบาร์โค้ด "8851234567890"
 *  - ลิงก์เว็บ เช่น "https://example.com/qr-lab.html?qr=SM-NP-001&mode=out"
 *  - รูปแบบขึ้นต้นด้วย "SM:" หรือ JSON {"qr":"SM-NP-001"}
 */
function parseQrPayload(rawInput) {
    const raw = String(rawInput || '').trim();
    if (!raw) return { code: '', embeddedMode: null, embeddedAmount: null };

    // 1. กรณีเป็น URL เช่น https://.../qr-lab.html?qr=SM-NP-001&mode=out
    if (/^https?:\/\//i.test(raw) || raw.includes('?qr=') || raw.includes('&qr=')) {
        try {
            const urlObj = new URL(raw.startsWith('http') ? raw : `https://local.test/${raw.replace(/^\//, '')}`);
            const code = (urlObj.searchParams.get('qr') || urlObj.searchParams.get('code') || '').trim();
            const mode = urlObj.searchParams.get('mode');
            const amt = parseInt(urlObj.searchParams.get('amount') || urlObj.searchParams.get('qty') || '', 10);
            if (code) {
                return {
                    code,
                    embeddedMode: mode === 'in' || mode === 'out' ? mode : null,
                    embeddedAmount: Number.isFinite(amt) && amt > 0 ? amt : null
                };
            }
        } catch (e) {
            // fallback to raw
        }
    }

    // 2. กรณีเป็น JSON
    if (raw.startsWith('{') && raw.endsWith('}')) {
        try {
            const obj = JSON.parse(raw);
            const code = String(obj.qr || obj.qrCode || obj.code || obj.sku || '').trim();
            if (code) {
                return {
                    code,
                    embeddedMode: obj.mode === 'in' || obj.mode === 'out' ? obj.mode : null,
                    embeddedAmount: Number(obj.amount) > 0 ? Number(obj.amount) : null
                };
            }
        } catch (e) {
            // fallback to raw
        }
    }

    // 3. กรณีขึ้นต้นด้วย SM:
    if (/^SM:/i.test(raw)) {
        return { code: raw.slice(3).trim(), embeddedMode: null, embeddedAmount: null };
    }

    return { code: raw, embeddedMode: null, embeddedAmount: null };
}

function generateAutoQrCode(team) {
    const prefix = team === 'team2' ? 'SM-MT' : 'SM-NP';
    const rand = Math.floor(1000 + Math.random() * 9000);
    return `${prefix}-${rand}`;
}

function sortProductsThai(rows) {
    return (rows || []).sort((a, b) => {
        const nameA = (a && a.name) ? String(a.name).trim() : '';
        const nameB = (b && b.name) ? String(b.name).trim() : '';
        if (!nameA && nameB) return 1;
        if (nameA && !nameB) return -1;
        const comp = nameA.localeCompare(nameB, 'th');
        if (comp !== 0) return comp;
        const sizeA = (a && (a.size || a.sku)) ? String(a.size || a.sku).trim() : '';
        const sizeB = (b && (b.size || b.sku)) ? String(b.size || b.sku).trim() : '';
        return sizeA.localeCompare(sizeB, 'th', { numeric: true });
    });
}

// 0. Heartbeat เช็กเวอร์ชันข้อมูลแบบเรียลไทม์ (แยกเฉพาะตาราง lab)
labRouter.get('/version', async (req, res) => {
    const team = req.query.team || 'team1';
    try {
        const result = await labDb.execute({
            sql: `
                SELECT
                    (SELECT COUNT(*) FROM lab_products WHERE COALESCE(team, 'team1') = ?) as count,
                    (SELECT COALESCE(MAX(id), 0) FROM lab_products WHERE COALESCE(team, 'team1') = ?) as max_id,
                    (SELECT COALESCE(SUM(quantity), 0) FROM lab_products WHERE COALESCE(team, 'team1') = ?) as total_qty,
                    (SELECT COALESCE(MAX(id), 0) FROM lab_logs WHERE COALESCE(team, 'team1') = ?) as log_id
            `,
            args: [team, team, team, team]
        });
        const row = result.rows[0];
        res.json({ v: `${row.count}_${row.max_id}_${row.total_qty}_${row.log_id}`, sandbox: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 1. ดึงรายการสินค้าทดลองทั้งหมด
labRouter.get('/products', async (req, res) => {
    const team = req.query.team || 'team1';
    const allTeams = req.query.all === '1';
    try {
        const result = allTeams
            ? await labDb.execute('SELECT * FROM lab_products')
            : await labDb.execute({
                sql: "SELECT * FROM lab_products WHERE COALESCE(team, 'team1') = ?",
                args: [team]
            });
        res.json(sortProductsThai(result.rows));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. ค้นหาสินค้าด้วย QR Code (ไม่เปลี่ยนสต็อก ใช้เช็กก่อนตัดสินใจ)
labRouter.get('/lookup', async (req, res) => {
    const { code } = parseQrPayload(req.query.qr || req.query.code || '');
    if (!code) return res.status(400).json({ error: 'กรุณาระบุรหัส QR Code' });
    try {
        const result = await labDb.execute({
            sql: 'SELECT * FROM lab_products WHERE LOWER(TRIM(qrCode)) = LOWER(TRIM(?)) LIMIT 1',
            args: [code]
        });
        const product = result.rows[0];
        if (!product) {
            return res.status(404).json({ found: false, qrCode: code, error: 'ไม่พบสินค้าที่มีรหัส QR นี้ในคลังทดลอง' });
        }
        res.json({ found: true, product });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. สแกน QR Code เพื่อรับเข้า / เบิกออก ทันที!
labRouter.post('/scan', async (req, res) => {
    const { qrCode: rawQr, mode: reqMode, amount: reqAmount, source, note } = req.body || {};
    const parsed = parseQrPayload(rawQr);
    const code = parsed.code;

    if (!code) {
        return res.status(400).json({ error: 'ไม่พบรหัส QR Code ที่สแกนได้' });
    }

    const mode = (reqMode === 'in' || reqMode === 'out') ? reqMode : (parsed.embeddedMode || 'out');
    const amount = Math.max(1, parseInt(reqAmount || parsed.embeddedAmount || 1, 10) || 1);
    const change = mode === 'in' ? amount : -amount;
    const scanSource = source || 'QR สแกน';

    try {
        // ค้นหาจาก qrCode เป็นหลัก (รองรับทั้งตัวพิมพ์เล็ก/ใหญ่)
        const pResult = await labDb.execute({
            sql: 'SELECT * FROM lab_products WHERE LOWER(TRIM(qrCode)) = LOWER(TRIM(?)) LIMIT 1',
            args: [code]
        });
        const product = pResult.rows[0];

        if (!product) {
            return res.status(404).json({
                success: false,
                notFound: true,
                qrCode: code,
                mode,
                amount,
                error: `ไม่พบสินค้ารหัส "${code}" ในคลังทดลอง — สามารถเพิ่มเข้าคลังได้ทันที`
            });
        }

        const oldQty = Number(product.quantity) || 0;
        const newQty = oldQty + change;
        if (newQty < 0) {
            return res.status(400).json({
                success: false,
                insufficientStock: true,
                product,
                error: `สต็อก "${product.name}" ไม่พอเบิก (คงเหลือ ${oldQty} ชิ้น, ต้องการเบิก ${amount} ชิ้น)`
            });
        }

        const now = new Date().toLocaleString('th-TH');
        const typeStr = mode === 'in' ? 'รับเข้า (QR)' : 'เบิกออก (QR)';
        const team = product.team || 'team1';
        const logNote = note
            ? `${note} (${oldQty} → ${newQty})`
            : `สแกน ${product.qrCode} (${oldQty} → ${newQty})`;

        const batchRes = await labDb.batch([
            {
                sql: 'UPDATE lab_products SET quantity = ?, updatedAt = ? WHERE id = ?',
                args: [newQty, now, product.id]
            },
            {
                sql: `INSERT INTO lab_logs (date, productId, qrCode, productName, type, changeAmount, amount, beforeQty, afterQty, source, note, team, undone)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
                args: [now, product.id, product.qrCode, product.name, typeStr, change, amount, oldQty, newQty, scanSource, logNote, team]
            }
        ], 'write');

        const logId = Number(batchRes[1].lastInsertRowid);
        const updatedProduct = { ...product, quantity: newQty, updatedAt: now };

        res.json({
            success: true,
            mode,
            amount,
            oldQuantity: oldQty,
            newQuantity: newQty,
            lowStock: newQty <= (Number(product.minStock) || 0),
            logId,
            product: updatedProduct
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. ยกเลิกการสแกนล่าสุด (1-Tap Undo)
labRouter.post('/undo/:logId', async (req, res) => {
    const logId = Number(req.params.logId);
    if (!logId) return res.status(400).json({ error: 'รหัสประวัติไม่ถูกต้อง' });

    try {
        const logRes = await labDb.execute({
            sql: 'SELECT * FROM lab_logs WHERE id = ? LIMIT 1',
            args: [logId]
        });
        const log = logRes.rows[0];
        if (!log) return res.status(404).json({ error: 'ไม่พบรายการประวัติที่ต้องการยกเลิก' });
        if (Number(log.undone) === 1) return res.status(400).json({ error: 'รายการนี้ถูกยกเลิกไปแล้ว' });
        if (!log.productId || !Number(log.changeAmount)) {
            return res.status(400).json({ error: 'ไม่สามารถยกเลิกรายการประเภทนี้ได้' });
        }

        const pRes = await labDb.execute({
            sql: 'SELECT * FROM lab_products WHERE id = ? LIMIT 1',
            args: [log.productId]
        });
        const product = pRes.rows[0];
        if (!product) return res.status(404).json({ error: 'ไม่พบสินค้าที่เกี่ยวข้อง' });

        const reverseChange = -Number(log.changeAmount);
        const oldQty = Number(product.quantity) || 0;
        const newQty = Math.max(0, oldQty + reverseChange);
        const now = new Date().toLocaleString('th-TH');

        await labDb.batch([
            {
                sql: 'UPDATE lab_products SET quantity = ?, updatedAt = ? WHERE id = ?',
                args: [newQty, now, product.id]
            },
            {
                sql: 'UPDATE lab_logs SET undone = 1 WHERE id = ?',
                args: [logId]
            },
            {
                sql: `INSERT INTO lab_logs (date, productId, qrCode, productName, type, changeAmount, amount, beforeQty, afterQty, source, note, team, undone)
                      VALUES (?, ?, ?, ?, 'ยกเลิกสแกน', ?, ?, ?, ?, 'Undo', ?, ?, 1)`,
                args: [
                    now,
                    product.id,
                    product.qrCode,
                    product.name,
                    reverseChange,
                    Math.abs(reverseChange),
                    oldQty,
                    newQty,
                    `ย้อนกลับรายการ #${logId} (${oldQty} → ${newQty})`,
                    product.team || 'team1'
                ]
            }
        ], 'write');

        res.json({
            success: true,
            product: { ...product, quantity: newQty, updatedAt: now },
            oldQuantity: oldQty,
            newQuantity: newQty
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. เพิ่มสินค้าใหม่ในโหมดทดลอง (รองรับกำหนด QR Code จากการสแกน หรือสร้างให้อัตโนมัติ)
labRouter.post('/products', async (req, res) => {
    const { qrCode, sku, name, category, size, price, quantity, minStock, image, team, source } = req.body || {};
    const targetTeam = team === 'team2' ? 'team2' : 'team1';
    const cleanName = String(name || '').trim();
    if (!cleanName) return res.status(400).json({ error: 'กรุณาระบุชื่อสินค้า' });

    const parsedQr = parseQrPayload(qrCode);
    const finalQr = parsedQr.code || generateAutoQrCode(targetTeam);
    const qty = Math.max(0, parseInt(quantity, 10) || 0);
    const min = Math.max(0, parseInt(minStock, 10) || 5);
    const now = new Date().toLocaleString('th-TH');

    try {
        const dupRes = await labDb.execute({
            sql: 'SELECT id, name FROM lab_products WHERE LOWER(TRIM(qrCode)) = LOWER(TRIM(?)) LIMIT 1',
            args: [finalQr]
        });
        if (dupRes.rows.length > 0) {
            return res.status(409).json({
                error: `รหัส QR "${finalQr}" ถูกใช้งานแล้วโดยสินค้า "${dupRes.rows[0].name}"`
            });
        }

        const results = await labDb.batch([
            {
                sql: `INSERT INTO lab_products (qrCode, sku, name, category, size, price, quantity, minStock, image, team, updatedAt)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                args: [
                    finalQr,
                    sku || size || '',
                    cleanName,
                    category || 'น้ำพริก',
                    size || sku || '',
                    parseFloat(price) || 0,
                    qty,
                    min,
                    image || '',
                    targetTeam,
                    now
                ]
            },
            {
                sql: `INSERT INTO lab_logs (date, productId, qrCode, productName, type, changeAmount, amount, beforeQty, afterQty, source, note, team, undone)
                      VALUES (?, NULL, ?, ?, 'เพิ่มสินค้าใหม่', ?, ?, 0, ?, ?, ?, ?, 0)`,
                args: [
                    now,
                    finalQr,
                    cleanName,
                    qty,
                    qty,
                    qty,
                    source || 'เพิ่มใหม่',
                    `รหัส QR: ${finalQr} | ขนาด: ${size || '-'}`,
                    targetTeam
                ]
            }
        ], 'write');

        const newId = Number(results[0].lastInsertRowid);
        res.json({
            success: true,
            id: newId,
            product: {
                id: newId,
                qrCode: finalQr,
                sku: sku || size || '',
                name: cleanName,
                category: category || 'น้ำพริก',
                size: size || sku || '',
                price: parseFloat(price) || 0,
                quantity: qty,
                minStock: min,
                image: image || '',
                team: targetTeam,
                updatedAt: now
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. แก้ไขสินค้าทดลอง
labRouter.put('/products/:id', async (req, res) => {
    const id = Number(req.params.id);
    const { qrCode, name, category, size, quantity, minStock, image, team } = req.body || {};

    try {
        const existingRes = await labDb.execute({
            sql: 'SELECT * FROM lab_products WHERE id = ? LIMIT 1',
            args: [id]
        });
        const existing = existingRes.rows[0];
        if (!existing) return res.status(404).json({ error: 'ไม่พบสินค้า' });

        const finalQr = parseQrPayload(qrCode).code || existing.qrCode;
        if (finalQr.toLowerCase() !== String(existing.qrCode).toLowerCase()) {
            const dup = await labDb.execute({
                sql: 'SELECT id FROM lab_products WHERE LOWER(TRIM(qrCode)) = LOWER(TRIM(?)) AND id != ? LIMIT 1',
                args: [finalQr, id]
            });
            if (dup.rows.length > 0) {
                return res.status(409).json({ error: `รหัส QR "${finalQr}" ซ้ำกับสินค้าอื่น` });
            }
        }

        const newQty = Math.max(0, parseInt(quantity, 10) || 0);
        const now = new Date().toLocaleString('th-TH');
        const targetTeam = team || existing.team || 'team1';

        await labDb.batch([
            {
                sql: `UPDATE lab_products
                      SET qrCode = ?, sku = ?, name = ?, category = ?, size = ?, quantity = ?, minStock = ?, image = ?, updatedAt = ?
                      WHERE id = ?`,
                args: [
                    finalQr,
                    size || '',
                    name || existing.name,
                    category || existing.category,
                    size || '',
                    newQty,
                    Math.max(0, parseInt(minStock, 10) || 0),
                    image !== undefined ? image : existing.image,
                    now,
                    id
                ]
            },
            {
                sql: `INSERT INTO lab_logs (date, productId, qrCode, productName, type, changeAmount, amount, beforeQty, afterQty, source, note, team, undone)
                      VALUES (?, ?, ?, ?, 'แก้ไขข้อมูล', ?, ?, ?, ?, 'แก้ไข', ?, ?, 0)`,
                args: [
                    now,
                    id,
                    finalQr,
                    name || existing.name,
                    newQty - Number(existing.quantity),
                    newQty,
                    Number(existing.quantity),
                    newQty,
                    `QR: ${finalQr} | ขนาด: ${size || '-'}`,
                    targetTeam
                ]
            }
        ], 'write');

        res.json({ success: true, updated: 1 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 7. ปรับสต็อกด่วนด้วยปุ่ม (+1 / -1)
labRouter.patch('/products/:id/stock', async (req, res) => {
    const id = Number(req.params.id);
    const change = parseInt(req.body?.changeAmount, 10);
    if (!change) return res.status(400).json({ error: 'จำนวนปรับสต็อกไม่ถูกต้อง' });

    try {
        const pRes = await labDb.execute({
            sql: 'SELECT * FROM lab_products WHERE id = ? LIMIT 1',
            args: [id]
        });
        const product = pRes.rows[0];
        if (!product) return res.status(404).json({ error: 'ไม่พบสินค้า' });

        const oldQty = Number(product.quantity) || 0;
        const newQty = oldQty + change;
        if (newQty < 0) return res.status(400).json({ error: 'สต็อกไม่สามารถติดลบได้' });

        const now = new Date().toLocaleString('th-TH');
        const typeStr = change > 0 ? 'รับเข้า' : 'เบิกออก';
        const batchRes = await labDb.batch([
            {
                sql: 'UPDATE lab_products SET quantity = ?, updatedAt = ? WHERE id = ?',
                args: [newQty, now, id]
            },
            {
                sql: `INSERT INTO lab_logs (date, productId, qrCode, productName, type, changeAmount, amount, beforeQty, afterQty, source, note, team, undone)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ปุ่มด่วน', ?, ?, 0)`,
                args: [
                    now,
                    id,
                    product.qrCode,
                    product.name,
                    typeStr,
                    change,
                    Math.abs(change),
                    oldQty,
                    newQty,
                    `ปรับสต็อก ${change > 0 ? '+' : ''}${change} (${oldQty} → ${newQty})`,
                    product.team || 'team1'
                ]
            }
        ], 'write');

        res.json({ success: true, quantity: newQty, logId: Number(batchRes[1].lastInsertRowid) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 8. ลบสินค้าทดลอง
labRouter.delete('/products/:id', async (req, res) => {
    const id = Number(req.params.id);
    try {
        await labDb.execute({ sql: 'DELETE FROM lab_products WHERE id = ?', args: [id] });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 9. ดึงประวัติความเคลื่อนไหวทดลอง
labRouter.get('/logs', async (req, res) => {
    const team = req.query.team || 'team1';
    const allTeams = req.query.all === '1';
    try {
        const result = allTeams
            ? await labDb.execute('SELECT * FROM lab_logs ORDER BY id DESC LIMIT 100')
            : await labDb.execute({
                sql: "SELECT * FROM lab_logs WHERE COALESCE(team, 'team1') = ? ORDER BY id DESC LIMIT 80",
                args: [team]
            });
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 10. รีเซ็ตข้อมูลเฉพาะโหมดทดลอง (ไม่แตะข้อมูลจริง)
labRouter.post('/reset', async (req, res) => {
    try {
        await labDb.batch([
            { sql: 'DELETE FROM lab_products', args: [] },
            { sql: 'DELETE FROM lab_logs', args: [] }
        ], 'write');
        await seedDemoProducts();
        res.json({ success: true, message: 'รีเซ็ตข้อมูลโหมดทดลองเรียบร้อยแล้ว' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = { labRouter, parseQrPayload };
