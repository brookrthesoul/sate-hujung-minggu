// db.js — public API called by orders.js / app.js
// All real work is done in sync.js. These are just named entry points.
// sync.js always loads first (see index.html script order).

async function getAllOrders() {
    return window._idbGetAll();
}

async function addOrder(order) {
    return window._sbAddOrder(order);
}

async function updateOrder(order) {
    return window._sbUpdateOrder(order);
}

async function deleteOrder(id) {
    return window._sbDeleteOrder(id);
}
