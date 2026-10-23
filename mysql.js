
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || 'srv1872.hstgr.io',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    connectTimeout: 10000
});

async function testConnection() {
    let connection;

    try {
        connection = await pool.getConnection();

        const [rows] = await connection.query(
        'SELECT DATABASE() AS database_name, NOW() AS server_time'        );

        console.log('MySQL connection successful!');
        console.log('Connected database:', rows[0].database_name);
console.log('Server time:', rows[0].server_time);
    } catch (error) {
        console.error('MySQL connection failed.');
        console.error('Error code:', error.code || 'Unknown');
        console.error('Error message:', error.message);
        throw error;
    } finally {
        if (connection) {
            connection.release();
        }
    }
}

module.exports = { pool, testConnection };
