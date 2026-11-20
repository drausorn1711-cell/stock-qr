const { createClient } = require('@libsql/client');
const path = require('path');
const os = require('os');

// ฐานข้อมูลสำหรับโหมดทดลอง QR Stock (แยกจากฐานข้อมูลจริง 100%)
// - หากรันในเครื่อง (Local): แยกไฟล์เป็น inventory-lab.db ไม่แตะ inventory.db เดิม
// - หากรันบน Cloud (Turso): ใช้เฉพาะตาราง lab_products และ lab_logs ไม่แตะตาราง products/logs เดิม
const isServerless = process.env.VERCEL || process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME;
const defaultLabDbPath = isServerless
    ? path.join(os.tmpdir(), 'inventory-lab.db')
    : path.join(__dirname, 'inventory-lab.db');

const labDbUrl = process.env.LAB_TURSO_DATABASE_URL || process.env.TURSO_DATABASE_URL || `file:${defaultLabDbPath}`;
const labAuthToken = process.env.LAB_TURSO_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN || undefined;

const labDb = createClient({
    url: labDbUrl,
    authToken: labAuthToken
});

const DEMO_PRODUCTS = [
    {
        qrCode: 'SM-NP-001',
        sku: 'กระปุกกลาง 150g',
        name: 'น้ำพริกอ่องสูตรดั้งเดิม',
        category: 'น้ำพริก',
        size: 'กระปุกกลาง 150g',
        quantity: 24,
        minStock: 8,
        team: 'team1'
    },
    {
        qrCode: 'SM-NP-002',
        sku: 'กระปุกเล็ก 100g',
        name: 'น้ำพริกตาแดงแมงดา',
        category: 'น้ำพริก',
        size: 'กระปุกเล็ก 100g',
        quantity: 6,
        minStock: 10,
        team: 'team1'
    },
    {
        qrCode: 'SM-DH-003',
        sku: 'ถุง 500g',
        name: 'กระเทียมเจียวกรอบคัดพิเศษ',
        category: 'ของแห้ง',
        size: 'ถุง 500g',
        quantity: 18,
        minStock: 5,
        team: 'team1'
    },
    {
        qrCode: 'SM-HB-004',
        sku: 'แพ็ค 250g',
        name: 'พริกทอดกรอบสมุนไพร',
        category: 'สมุนไพร',
        size: 'แพ็ค 250g',
        quantity: 12,
        minStock: 6,
        team: 'team1'
    },
    {
        qrCode: 'SM-MT-101',
        sku: 'กล่อง 1 กก.',
        name: 'หมูฝอยกรอบพรีเมียม',
        category: 'ของแห้ง',
        size: 'กล่อง 1 กก.',
        quantity: 15,
        minStock: 5,
        team: 'team2'
    },
    {
        qrCode: 'SM-MT-102',
        sku: 'แพ็ค 200g',
        name: 'ปลาหมึกเชื่อมสามรส',
        category: 'ของนำเข้า',
        size: 'แพ็ค 200g',
        quantity: 4,
        minStock: 6,
        team: 'team2'
    }
];

async function initLabDb() {
    await labDb.execute(`
        CREATE TABLE IF NOT EXISTS lab_products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            qrCode TEXT NOT NULL UNIQUE,
            sku TEXT,
            name TEXT NOT NULL,
            category TEXT NOT NULL,
            size TEXT,
            price REAL DEFAULT 0,
            quantity INTEGER NOT NULL DEFAULT 0,
            minStock INTEGER NOT NULL DEFAULT 5,
            image TEXT,
            team TEXT DEFAULT 'team1',
            updatedAt TEXT
        )
    `);

    await labDb.execute(`
        CREATE TABLE IF NOT EXISTS lab_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            productId INTEGER,
            qrCode TEXT,
            productName TEXT NOT NULL,
            type TEXT NOT NULL,
            changeAmount INTEGER NOT NULL DEFAULT 0,
            amount INTEGER NOT NULL,
            beforeQty INTEGER,
            afterQty INTEGER,
            source TEXT DEFAULT 'QR',
            note TEXT,
            team TEXT DEFAULT 'team1',
            undone INTEGER DEFAULT 0
        )
    `);

    // เติมข้อมูลทดลองเริ่มต้นอัตโนมัติหากตารางทดลองยังว่างอยู่
    const countRes = await labDb.execute('SELECT COUNT(*) as cnt FROM lab_products');
    const cnt = Number(countRes.rows[0]?.cnt || 0);
    if (cnt === 0) {
        await seedDemoProducts();
    }
}

async function seedDemoProducts() {
    const now = new Date().toLocaleString('th-TH');
    const stmts = [];
    for (const item of DEMO_PRODUCTS) {
        stmts.push({
            sql: `INSERT OR IGNORE INTO lab_products (qrCode, sku, name, category, size, price, quantity, minStock, image, team, updatedAt)
                  VALUES (?, ?, ?, ?, ?, 0, ?, ?, '', ?, ?)`,
            args: [item.qrCode, item.sku, item.name, item.category, item.size, item.quantity, item.minStock, item.team, now]
        });
    }
    stmts.push({
        sql: `INSERT INTO lab_logs (date, productId, qrCode, productName, type, changeAmount, amount, beforeQty, afterQty, source, note, team)
              VALUES (?, NULL, 'SYSTEM', 'ระบบทดลอง QR Stock', 'เริ่มชุดข้อมูลทดลอง', 0, ?, 0, ?, 'ระบบ', 'สร้างสินค้าตัวอย่างสำหรับทดสอบสแกน QR', 'team1')`,
        args: [now, DEMO_PRODUCTS.length, DEMO_PRODUCTS.length]
    });
    await labDb.batch(stmts, 'write');
}

module.exports = { labDb, initLabDb, seedDemoProducts, DEMO_PRODUCTS };
