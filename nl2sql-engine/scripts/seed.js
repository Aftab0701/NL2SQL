const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'nl2sql.db');

const SCHEMA_SQL = `
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS employees;

CREATE TABLE customers (
    customer_id INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL UNIQUE,
    city        TEXT NOT NULL,
    country     TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE TABLE products (
    product_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    category       TEXT NOT NULL,
    price          REAL NOT NULL,
    stock_quantity INTEGER NOT NULL
);

CREATE TABLE orders (
    order_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id  INTEGER NOT NULL REFERENCES customers(customer_id),
    order_date   TEXT NOT NULL,
    status       TEXT NOT NULL,
    order_total  REAL NOT NULL
);

CREATE TABLE order_items (
    order_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id      INTEGER NOT NULL REFERENCES orders(order_id),
    product_id    INTEGER NOT NULL REFERENCES products(product_id),
    quantity      INTEGER NOT NULL,
    unit_price    REAL NOT NULL
);

CREATE TABLE employees (
    employee_id INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    department  TEXT NOT NULL,
    title       TEXT NOT NULL,
    hire_date   TEXT NOT NULL,
    salary      REAL NOT NULL
);
`;

const FIRST_NAMES = ["Aarav", "Priya", "Liam", "Emma", "Noah", "Olivia", "Wei", "Mei", "Carlos", "Sofia",
               "James", "Ava", "Mohammed", "Fatima", "Ken", "Yuki", "Ethan", "Isabella", "Lucas", "Mia",
               "Arjun", "Ananya", "Daniel", "Grace", "Ravi", "Neha", "Tom", "Chloe", "Hassan", "Layla"];
const LAST_NAMES = ["Sharma", "Patel", "Smith", "Johnson", "Chen", "Wang", "Garcia", "Rodriguez", "Kim", "Lee",
              "Brown", "Davis", "Khan", "Ali", "Nguyen", "Tran", "Muller", "Rossi", "Silva", "Costa"];
const CITIES = [["Mumbai", "India"], ["Bengaluru", "India"], ["Delhi", "India"], ["New York", "USA"],
          ["San Francisco", "USA"], ["London", "UK"], ["Berlin", "Germany"], ["Toronto", "Canada"],
          ["Sydney", "Australia"], ["Singapore", "Singapore"], ["Tokyo", "Japan"], ["Dubai", "UAE"]];

const PRODUCT_CATALOG = [
    ["Wireless Mouse", "Electronics", 799], ["Mechanical Keyboard", "Electronics", 3499],
    ["USB-C Hub", "Electronics", 1899], ["27in Monitor", "Electronics", 15999],
    ["Noise Cancelling Headphones", "Electronics", 8999], ["Webcam 1080p", "Electronics", 2599],
    ["Laptop Stand", "Accessories", 1299], ["Desk Lamp", "Accessories", 999],
    ["Ergonomic Chair", "Furniture", 12999], ["Standing Desk", "Furniture", 18999],
    ["Notebook Set", "Stationery", 249], ["Fountain Pen", "Stationery", 599],
    ["Backpack", "Accessories", 2199], ["Water Bottle", "Accessories", 399],
    ["Running Shoes", "Footwear", 4599], ["Yoga Mat", "Fitness", 1099],
    ["Dumbbell Set 10kg", "Fitness", 3299], ["Resistance Bands", "Fitness", 699],
    ["Blender", "Home", 2999], ["Air Fryer", "Home", 6499],
    ["Coffee Maker", "Home", 3799], ["Electric Kettle", "Home", 1599],
    ["Bluetooth Speaker", "Electronics", 2999], ["Smartwatch", "Electronics", 9999],
    ["Phone Case", "Accessories", 499], ["Screen Protector", "Accessories", 299],
    ["Graphic Novel", "Books", 799], ["Cookbook", "Books", 899],
    ["Board Game", "Toys", 1499], ["Puzzle 1000pc", "Toys", 799],
    ["Desk Organizer", "Accessories", 649]
];

const DEPARTMENTS = ["Engineering", "Sales", "Marketing", "HR", "Finance", "Customer Support", "Product", "Design"];
const TITLES = {
    "Engineering": ["Software Engineer", "Senior Software Engineer", "Engineering Manager", "QA Engineer"],
    "Sales": ["Sales Executive", "Account Manager", "Sales Director"],
    "Marketing": ["Marketing Associate", "Content Strategist", "Marketing Manager"],
    "HR": ["HR Generalist", "Recruiter", "HR Manager"],
    "Finance": ["Financial Analyst", "Accountant", "Finance Manager"],
    "Customer Support": ["Support Associate", "Support Team Lead"],
    "Product": ["Product Manager", "Product Analyst"],
    "Design": ["UI/UX Designer", "Design Lead"],
};
const STATUSES = ["completed", "completed", "completed", "shipped", "processing", "cancelled"];

function randItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randDate(startYear, endYear) {
    const start = new Date(startYear, 0, 1).getTime();
    const end = new Date(endYear, 6, 11).getTime();
    const d = new Date(start + Math.random() * (end - start));
    return d.toISOString().split('T')[0];
}

function seed() {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    
    // Create DB connection
    const db = new Database(DB_PATH);
    db.pragma('foreign_keys = ON');

    // Execute schema
    db.exec(SCHEMA_SQL);

    const insertCustomer = db.prepare("INSERT INTO customers (name, email, city, country, created_at) VALUES (?, ?, ?, ?, ?)");
    const insertProduct = db.prepare("INSERT INTO products (name, category, price, stock_quantity) VALUES (?, ?, ?, ?)");
    const insertOrder = db.prepare("INSERT INTO orders (customer_id, order_date, status, order_total) VALUES (?, ?, ?, ?)");
    const insertOrderItem = db.prepare("INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)");
    const insertEmployee = db.prepare("INSERT INTO employees (name, department, title, hire_date, salary) VALUES (?, ?, ?, ?, ?)");

    const _customers = [];
    const _products = [];
    let orderCount = 0;
    let orderItemCount = 0;
    let employeeCount = 0;

    const seedTransaction = db.transaction(() => {
        // customers
        for (let i = 0; i < 60; i++) {
            let fn = randItem(FIRST_NAMES), ln = randItem(LAST_NAMES);
            let [city, country] = randItem(CITIES);
            let email = `${fn.toLowerCase()}.${ln.toLowerCase()}${randInt(1,999)}@example.com`;
            let r = insertCustomer.run(fn + " " + ln, email, city, country, randDate(2021, 2025));
            _customers.push(r.lastInsertRowid);
        }

        // products
        for (let i = 0; i < 60; i++) {
            let [name, category, base_price] = PRODUCT_CATALOG[i % PRODUCT_CATALOG.length];
            let variantSuffix = i < PRODUCT_CATALOG.length ? "" : ` v${Math.floor(i / PRODUCT_CATALOG.length) + 1}`;
            let price = Math.round(base_price * (0.9 + Math.random() * 0.25) * 100) / 100;
            let stock = randItem([0, 0, 3, 8, 15, 22, 40, 75, 120]);
            let r = insertProduct.run(name + variantSuffix, category, price, stock);
            _products.push({ id: r.lastInsertRowid, price });
        }

        // orders + order_items
        for (let i = 0; i < 90; i++) {
            let customer_id = randItem(_customers);
            let order_date = randDate(2024, 2026);
            let status = randItem(STATUSES);
            let n_items = randInt(1, 4);
            
            let chosenProducts = [];
            while (chosenProducts.length < n_items) {
                let p = randItem(_products);
                if (!chosenProducts.includes(p)) chosenProducts.push(p);
            }

            let order_total = 0.0;
            for (let p of chosenProducts) {
                let qty = randInt(1, 3);
                order_total += p.price * qty;
            }
            order_total = Math.round(order_total * 100) / 100;

            let orderRes = insertOrder.run(customer_id, order_date, status, order_total);
            let order_id = orderRes.lastInsertRowid;
            orderCount++;

            for (let p of chosenProducts) {
                let qty = randInt(1, 3);
                insertOrderItem.run(order_id, p.id, qty, p.price);
                orderItemCount++;
            }
        }

        // employees
        for (let i = 0; i < 55; i++) {
            let fn = randItem(FIRST_NAMES), ln = randItem(LAST_NAMES);
            let dept = randItem(DEPARTMENTS);
            let title = randItem(TITLES[dept]);
            let hire_date = randDate(2019, 2026);
            let base_salary = {"Engineering": 1400000, "Sales": 900000, "Marketing": 850000, "HR": 750000,
                            "Finance": 950000, "Customer Support": 600000, "Product": 1300000, "Design": 1100000}[dept];
            let salary = Math.round(base_salary * (0.8 + Math.random() * 0.6) * 100) / 100;
            insertEmployee.run(fn + " " + ln, dept, title, hire_date, salary);
            employeeCount++;
        }
    });

    seedTransaction();
    db.close();

    console.log(`Seeded database at ${DB_PATH}`);
    console.log(`  customers:   ${_customers.length} rows`);
    console.log(`  products:    ${_products.length} rows`);
    console.log(`  orders:      ${orderCount} rows`);
    console.log(`  order_items: ${orderItemCount} rows`);
    console.log(`  employees:   ${employeeCount} rows`);
}

seed();
