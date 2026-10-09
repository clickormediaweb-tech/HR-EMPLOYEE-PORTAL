const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    password: {
        type: String,
        required: true
    },
    role: {
        type: String,
        enum: ['hr', 'employee'],
        required: true,
        default: 'employee'
    },
    designation: {
        type: String,
        default: 'Staff'
    },
    department: {
        type: String,
        default: 'General'
    },
    phone: {
        type: String,
        default: ''
    },
    avatar: {
        type: String,
        default: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&h=100&fit=crop&crop=faces'
    }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);