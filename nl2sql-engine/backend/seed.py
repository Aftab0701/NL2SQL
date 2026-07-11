"""
seed.py
Creates the schema and seeds it with realistic, relationally-consistent sample data.

Schema (e-commerce + a lightweight HR slice, so both example families in the
brief -- "top customers by spend" and "employees in Engineering hired after
2022" -- are backed by real tables):

  customers   (customer_id PK)
  products    (product_id PK)
  orders      (order_id PK, customer_id FK -> customers)
  order_items (order_item_id PK, order_id FK -> orders, product_id FK -> products)
  employees   (employee_id PK)

Run:  python backend/seed.py   (safe to re-run -- it drops and recreates tables)
"""

import random
import sqlite3
from datetime import datetime, timedelta

from .database import get_writable_connection, DB_PATH

random.seed(42)  # reproducible data across runs

SCHEMA_SQL = """
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
"""

FIRST_NAMES = ["Aarav", "Priya", "Liam", "Emma", "Noah", "Olivia", "Wei", "Mei", "Carlos", "Sofia",
               "James", "Ava", "Mohammed", "Fatima", "Ken", "Yuki", "Ethan", "Isabella", "Lucas", "Mia",
               "Arjun", "Ananya", "Daniel", "Grace", "Ravi", "Neha", "Tom", "Chloe", "Hassan", "Layla"]
LAST_NAMES = ["Sharma", "Patel", "Smith", "Johnson", "Chen", "Wang", "Garcia", "Rodriguez", "Kim", "Lee",
              "Brown", "Davis", "Khan", "Ali", "Nguyen", "Tran", "Muller", "Rossi", "Silva", "Costa"]
CITIES = [("Mumbai", "India"), ("Bengaluru", "India"), ("Delhi", "India"), ("New York", "USA"),
          ("San Francisco", "USA"), ("London", "UK"), ("Berlin", "Germany"), ("Toronto", "Canada"),
          ("Sydney", "Australia"), ("Singapore", "Singapore"), ("Tokyo", "Japan"), ("Dubai", "UAE")]

PRODUCT_CATALOG = [
    ("Wireless Mouse", "Electronics", 799), ("Mechanical Keyboard", "Electronics", 3499),
    ("USB-C Hub", "Electronics", 1899), ("27in Monitor", "Electronics", 15999),
    ("Noise Cancelling Headphones", "Electronics", 8999), ("Webcam 1080p", "Electronics", 2599),
    ("Laptop Stand", "Accessories", 1299), ("Desk Lamp", "Accessories", 999),
    ("Ergonomic Chair", "Furniture", 12999), ("Standing Desk", "Furniture", 18999),
    ("Notebook Set", "Stationery", 249), ("Fountain Pen", "Stationery", 599),
    ("Backpack", "Accessories", 2199), ("Water Bottle", "Accessories", 399),
    ("Running Shoes", "Footwear", 4599), ("Yoga Mat", "Fitness", 1099),
    ("Dumbbell Set 10kg", "Fitness", 3299), ("Resistance Bands", "Fitness", 699),
    ("Blender", "Home", 2999), ("Air Fryer", "Home", 6499),
    ("Coffee Maker", "Home", 3799), ("Electric Kettle", "Home", 1599),
    ("Bluetooth Speaker", "Electronics", 2999), ("Smartwatch", "Electronics", 9999),
    ("Phone Case", "Accessories", 499), ("Screen Protector", "Accessories", 299),
    ("Graphic Novel", "Books", 799), ("Cookbook", "Books", 899),
    ("Board Game", "Toys", 1499), ("Puzzle 1000pc", "Toys", 799),
    ("Desk Organizer", "Accessories", 649),
]

DEPARTMENTS = ["Engineering", "Sales", "Marketing", "HR", "Finance", "Customer Support", "Product", "Design"]
TITLES = {
    "Engineering": ["Software Engineer", "Senior Software Engineer", "Engineering Manager", "QA Engineer"],
    "Sales": ["Sales Executive", "Account Manager", "Sales Director"],
    "Marketing": ["Marketing Associate", "Content Strategist", "Marketing Manager"],
    "HR": ["HR Generalist", "Recruiter", "HR Manager"],
    "Finance": ["Financial Analyst", "Accountant", "Finance Manager"],
    "Customer Support": ["Support Associate", "Support Team Lead"],
    "Product": ["Product Manager", "Product Analyst"],
    "Design": ["UI/UX Designer", "Design Lead"],
}
STATUSES = ["completed", "completed", "completed", "shipped", "processing", "cancelled"]


def rand_date(start_year=2021, end_year=2026):
    start = datetime(start_year, 1, 1)
    end = datetime(end_year, 7, 11)
    delta = end - start
    return (start + timedelta(days=random.randint(0, delta.days))).strftime("%Y-%m-%d")


def seed():
    conn = get_writable_connection()
    cur = conn.cursor()
    cur.executescript(SCHEMA_SQL)

    # --- customers (60 rows) ---
    customers = []
    for _ in range(60):
        fn, ln = random.choice(FIRST_NAMES), random.choice(LAST_NAMES)
        city, country = random.choice(CITIES)
        email = f"{fn.lower()}.{ln.lower()}{random.randint(1,999)}@example.com"
        customers.append((fn + " " + ln, email, city, country, rand_date(2021, 2025)))
    cur.executemany(
        "INSERT INTO customers (name, email, city, country, created_at) VALUES (?, ?, ?, ?, ?)",
        customers,
    )

    # --- products (60 rows, cycling + variating the 30-item catalog) ---
    products = []
    for i in range(60):
        name, category, base_price = PRODUCT_CATALOG[i % len(PRODUCT_CATALOG)]
        variant_suffix = "" if i < len(PRODUCT_CATALOG) else f" v{i // len(PRODUCT_CATALOG) + 1}"
        price = round(base_price * random.uniform(0.9, 1.15), 2)
        stock = random.choice([0, 0, 3, 8, 15, 22, 40, 75, 120])
        products.append((name + variant_suffix, category, price, stock))
    cur.executemany(
        "INSERT INTO products (name, category, price, stock_quantity) VALUES (?, ?, ?, ?)",
        products,
    )

    n_customers = len(customers)
    n_products = len(products)

    # --- orders (90 rows) + order_items (~230 rows) ---
    orders = []
    order_items = []
    for order_id in range(1, 91):
        customer_id = random.randint(1, n_customers)
        order_date = rand_date(2024, 2026)
        status = random.choice(STATUSES)
        n_items = random.randint(1, 4)
        chosen_products = random.sample(range(1, n_products + 1), n_items)
        order_total = 0.0
        for product_id in chosen_products:
            unit_price = products[product_id - 1][2]
            quantity = random.randint(1, 3)
            order_items.append((order_id, product_id, quantity, unit_price))
            order_total += unit_price * quantity
        orders.append((customer_id, order_date, status, round(order_total, 2)))

    cur.executemany(
        "INSERT INTO orders (customer_id, order_date, status, order_total) VALUES (?, ?, ?, ?)",
        orders,
    )
    cur.executemany(
        "INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)",
        order_items,
    )

    # --- employees (55 rows) ---
    employees = []
    for _ in range(55):
        fn, ln = random.choice(FIRST_NAMES), random.choice(LAST_NAMES)
        dept = random.choice(DEPARTMENTS)
        title = random.choice(TITLES[dept])
        hire_date = rand_date(2019, 2026)
        base_salary = {"Engineering": 1400000, "Sales": 900000, "Marketing": 850000, "HR": 750000,
                        "Finance": 950000, "Customer Support": 600000, "Product": 1300000, "Design": 1100000}[dept]
        salary = round(base_salary * random.uniform(0.8, 1.4), 2)
        employees.append((fn + " " + ln, dept, title, hire_date, salary))
    cur.executemany(
        "INSERT INTO employees (name, department, title, hire_date, salary) VALUES (?, ?, ?, ?, ?)",
        employees,
    )

    conn.commit()
    conn.close()

    print(f"Seeded database at {DB_PATH}")
    print(f"  customers:   {len(customers)} rows")
    print(f"  products:    {len(products)} rows")
    print(f"  orders:      {len(orders)} rows")
    print(f"  order_items: {len(order_items)} rows")
    print(f"  employees:   {len(employees)} rows")


if __name__ == "__main__":
    seed()
