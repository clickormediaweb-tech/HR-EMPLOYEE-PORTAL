const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const MONGO_URI = "mongodb+srv://clickormediaweb_db_user:Clickormedia123@cluster0.uqgeway.mongodb.net/hr_portal?retryWrites=true&w=majority&appName=Cluster0";

const storeSchema = new mongoose.Schema({
    data: { type: Object, default: {} }
}, { strict: false });

const Store = mongoose.model('Store', storeSchema);

async function seedDatabase() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log("--- CONNECTED TO MONGODB FOR SEEDING ---");

        const dbFilePath = path.join(__dirname, 'database.json');
        if (!fs.existsSync(dbFilePath)) {
            console.log("Error: database.json file not found!");
            process.exit(1);
        }

        const rawData = fs.readFileSync(dbFilePath, 'utf8');
        const jsonData = JSON.parse(rawData);

        // Purana sara data delete karke naya sahi format me dalenge
        await Store.deleteMany({});
        await Store.create({ data: jsonData });

        console.log("--- SUCCESS: database.json data successfully uploaded to MongoDB! ---");
        process.exit(0);
    } catch (err) {
        console.error("Seeding error:", err);
        process.exit(1);
    }
}

seedDatabase();