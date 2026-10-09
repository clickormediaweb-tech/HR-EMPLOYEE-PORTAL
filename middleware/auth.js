// middleware/auth.js
const User = require('../models/User');

const verifyAuth = async (req, res, next) => {
    // For now, we will allow access or check session cookies
    // We will expand this as we build full cookie-based JWT sessions next!
    next();
};

module.exports = { verifyAuth };