const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('./models/User');

const seedData = async () => {
    try {
        // Spin up an automatic temporary database
        const mongoServer = await MongoMemoryServer.create();
        const uri = mongoServer.getUri();

        await mongoose.connect(uri);
        console.log('Connected to temporary local database...');

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash('123456', salt);

        // Create HR User
        const hrUser = new User({
            name: 'Tanya Dua',
            email: 'tanya.dua@clickormedia.co.in',
            password: hashedPassword,
            role: 'hr',
            designation: 'HR Manager',
            department: 'Human Resources',
            phone: '+91 98765 43210',
            avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&h=100&fit=crop&crop=faces'
        });

        // Create Employee User
        const empUser = new User({
            name: 'Pranchal Rajpal',
            email: 'pranchal@clickormedia.co.in',
            password: hashedPassword,
            role: 'employee',
            designation: 'Software Developer',
            department: 'Engineering',
            phone: '+91 91234 56789',
            avatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=100&h=100&fit=crop&crop=faces'
        });

        await hrUser.save();
        await empUser.save();

        console.log('Database seeded successfully!');
        console.log('HR Login: tanya.dua@clickormedia.co.in / 123456');
        console.log('Employee Login: pranchal@clickormedia.co.in / 123456');
        
        await mongoose.disconnect();
        await mongoServer.stop();
        process.exit();
    } catch (err) {
        console.error('Error seeding data:', err);
        process.exit(1);
    }
};

seedData();