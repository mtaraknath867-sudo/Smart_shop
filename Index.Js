global.fetch = require("node-fetch");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

const FIREBASE_URL = process.env.FIREBASE_URL;

// 🟣 YOUR UPI ID
const UPI_ID = "7557065629-2@axl";
const BUSINESS_NAME = "Smart Shop";

const orderStates = {};

// 🔗 Generate Dynamic UPI Payment Link
function generateUPILink(amount) {
    return `upi://pay?pa=${UPI_ID}&pn=${encodeURIComponent(BUSINESS_NAME)}&am=${amount}&cu=INR`;
}

// 📦 Fetch Products
async function getProducts() {
    try {
        const res = await fetch(`${FIREBASE_URL}/products.json`);
        const data = await res.json();
        if (!data) return [];

        return Object.keys(data).map(key => ({
            id: key,
            name: data[key].name,
            price: data[key].price,
            imageUrl: data[key].imageUrl,
            model: data[key].model
        }));
    } catch (err) {
        console.log("❌ Product fetch error:", err);
        return [];
    }
}

async function startBot() {

    if (!FIREBASE_URL) {
        console.log("❌ FIREBASE_URL not set!");
        process.exit(1);
    }

    const { state, saveCreds } = await useMultiFileAuthState('session_data');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    // 🔗 Connection
    sock.ev.on('connection.update', (update) => {
        const { connection, qr } = update;

        if (qr) {
            console.clear();
            console.log("📲 Scan QR:");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') console.log("✅ Bot Connected!");
    });

    sock.ev.on('creds.update', saveCreds);

    // 💬 Message
    sock.ev.on('messages.upsert', async (m) => {

        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase().trim();

        // ================= PAYMENT CONFIRM =================
        if (orderStates[sender]?.step === "PAYMENT" && text === "paid") {

            const data = orderStates[sender];
            const number = sender.split('@')[0];

            const order = {
                userId: "wa_" + number,
                phone: number,
                address: data.address,
                product: data.item.name,
                model: data.item.model,
                total: data.amount,
                paymentType: data.type,
                status: "Confirmed",
                createdAt: new Date().toISOString()
            };

            await fetch(`${FIREBASE_URL}/orders.json`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(order)
            });

            await sock.sendMessage(sender, {
                text: `✅ Payment Received!

📦 Order Confirmed
💰 ₹${data.amount}
🚚 Delivery in 3-5 days

🙏 Thank you!`
            });

            delete orderStates[sender];
            return;
        }

        // ================= ADDRESS STEP =================
        if (orderStates[sender]?.step === "ADDRESS") {

            const item = orderStates[sender].item;

            orderStates[sender] = {
                step: "PAYMENT_OPTION",
                item,
                address: text
            };

            await sock.sendMessage(sender, {
                text: `💳 *Choose Payment Method*

1️⃣ Online Payment (Full ₹${item.price})
2️⃣ Cash on Delivery (₹50 Advance)

👉 Reply 1 or 2`
            });

            return;
        }

        // ================= PAYMENT OPTION =================
        if (orderStates[sender]?.step === "PAYMENT_OPTION") {

            const data = orderStates[sender];
            const item = data.item;

            let amount = 0;
            let type = "";

            if (text === "1") {
                amount = parseFloat(item.price);
                type = "Full Payment";
            } 
            else if (text === "2") {
                amount = 50;
                type = "COD Advance";
            } 
            else {
                await sock.sendMessage(sender, { text: "❌ Please reply 1 or 2" });
                return;
            }

            const upiLink = generateUPILink(amount);

            orderStates[sender] = {
                step: "PAYMENT",
                item,
                address: data.address,
                amount,
                type
            };

            await sock.sendMessage(sender, {
                text: `💰 *Payment Required*

📱 ${item.name}
💵 Amount: ₹${amount}

🔗 Pay Now:
${upiLink}

👉 After payment type *paid*`
            });

            return;
        }

        // ================= ORDER START =================
        if (text.startsWith("order ")) {

            const search = text.replace("order ", "").trim();
            const products = await getProducts();

            const found = products.find(p =>
                p.name.toLowerCase().includes(search) ||
                p.model.toLowerCase().includes(search)
            );

            if (!found) {
                await sock.sendMessage(sender, { text: "❌ Product not found\n👉 menu" });
                return;
            }

            orderStates[sender] = { step: "ADDRESS", item: found };

            await sock.sendMessage(sender, {
                text: `🛒 Order Started

📱 ${found.name}
📲 ${found.model}
💰 ₹${found.price}

👉 Send Name + Address`
            });
        }

        // ================= MENU =================
        else if (text === "menu") {

            const products = await getProducts();

            let menu = "📱 *BACK COVER SHOP*\n\n";

            products.forEach(p => {
                menu += `🔹 ${p.name} (${p.model}) - ₹${p.price}\n`;
            });

            menu += "\n👉 order model name";

            await sock.sendMessage(sender, { text: menu });
        }

        // ================= GREETING =================
        else if (["hi", "hello"].includes(text)) {
            await sock.sendMessage(sender, {
                text: "👋 Welcome to Smart Shop\nType menu"
            });
        }

        else {
            await sock.sendMessage(sender, {
                text: "❓ Type menu"
            });
        }

    });
}

startBot();
