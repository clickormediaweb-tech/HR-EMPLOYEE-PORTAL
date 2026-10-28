require('dotenv').config();
const { pool } = require('./mysql');
const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');    
const session = require('express-session'); // <-- Added for session management
const bcrypt = require('bcryptjs');
const app = express();

// --- SHARED MONTHLY LEAVE CALCULATION ---
function getLeaveMonthDates(year, month) {
    return {
        start: `${year}-${String(month).padStart(2, '0')}-01`,
        end: `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`
    };
}

function parseJoiningDate(value) {
    if (!value) return null;

    // Handles dates such as "01 September 2026"
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function countApprovedLeaveDays(leave, monthStart, monthEnd) {
    if (!leave.startDate || !leave.endDate) return 0;

    const start = leave.startDate;
    const end = leave.endDate;

    if (end < monthStart || start > monthEnd) return 0;

    const effectiveStart = start > monthStart ? start : monthStart;
    const effectiveEnd = end < monthEnd ? end : monthEnd;

    const startDate = new Date(`${effectiveStart}T00:00:00Z`);
    const endDate = new Date(`${effectiveEnd}T00:00:00Z`);

    return Math.floor((endDate - startDate) / 86400000) + 1;
}





function calculateMonthlyLeave(payrollRec, allLeaves, year, month) {
    const emptyResult = {
        earned: 0,
        used: 0,
        paidUsed: 0,
        unpaid: 0,
        unpaidHalfDays: 0,
        balance: 0
    };

    // Leave system officially starts in October 2026.
    const startYear = 2026;
    const startMonth = 10;

    if (
        year < startYear ||
        (year === startYear && month < startMonth)
    ) {
        return emptyResult;
    }

    const earned =
        (year - startYear) * 12 + (month - startMonth) + 1;

    const pad = value => String(value).padStart(2, "0");

    function monthRange(y, m) {
        return {
            start: `${y}-${pad(m)}-01`,
            end: `${y}-${pad(m)}-${new Date(Date.UTC(y, m, 0)).getUTCDate()}`
        };
    }

    function countWorkingDays(start, end) {
        if (!start || !end || start > end) return 0;

        const date = new Date(`${start}T00:00:00Z`);
        const last = new Date(`${end}T00:00:00Z`);

        if (
            Number.isNaN(date.getTime()) ||
            Number.isNaN(last.getTime())
        ) {
            return 0;
        }

        let count = 0;

        while (date <= last) {
            // Sunday is the weekly off.
            if (date.getUTCDay() !== 0) count++;
            date.setUTCDate(date.getUTCDate() + 1);
        }

        return count;
    }

    const employeeName =
        String(payrollRec.name || "").trim().toLowerCase();

    const approvedLeaves = (
        Array.isArray(allLeaves) ? allLeaves : []
    ).filter(leave =>
        leave &&
        String(leave.status || "").toUpperCase() === "APPROVED" &&
        String(leave.name || "").trim().toLowerCase() === employeeName &&
        leave.startDate &&
        leave.endDate
    );

    function usageForMonth(y, m) {
        const range = monthRange(y, m);
        let fullDays = 0;
        let halfDays = 0;

        for (const leave of approvedLeaves) {
            const start = String(leave.startDate).slice(0, 10);
            const end = String(leave.endDate).slice(0, 10);

            const overlapStart =
                start > range.start ? start : range.start;
            const overlapEnd =
                end < range.end ? end : range.end;

            if (overlapStart > overlapEnd) continue;

            const days = countWorkingDays(overlapStart, overlapEnd);

            const isHalfDay =
                /half.?day/i.test(
                    `${leave.duration || ""} ${leave.dayType || ""} ${leave.type || ""}`
                );

            if (isHalfDay) {
                halfDays += days > 0 ? 0.5 : 0;
            } else {
                fullDays += days;
            }
        }

        return {
            fullDays,
            halfDays,
            total: fullDays + halfDays
        };
    }

    let usedBeforeMonth = 0;

    for (
        let y = startYear, m = startMonth;
        y < year || (y === year && m < month);
    ) {
        usedBeforeMonth += usageForMonth(y, m).total;

        m++;
        if (m > 12) {
            m = 1;
            y++;
        }
    }

    const currentUsage = usageForMonth(year, month);
    const used = currentUsage.total;

    const available = Math.max(0, earned - usedBeforeMonth);
    const paidUsed = Math.min(available, used);
    const unpaid = Math.max(0, used - paidUsed);
    const balance = Math.max(0, available - paidUsed);

    return {
        earned,
        used,
        paidUsed,
        unpaid,
        unpaidHalfDays: Math.min(
            currentUsage.halfDays,
            unpaid * 2
        ),
        balance
    };
} // Safe Reader

function calculateMonthlyAbsences(
    employee,
    attendanceRecords,
    approvedLeaves,
    holidays,
    settings,
    year,
    month
) {
    const pad = value => String(value).padStart(2, "0");

    const today = new Date();
    const todayDate =
        `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

    const monthStart = `${year}-${pad(month)}-01`;
    const monthEnd =
        `${year}-${pad(month)}-${new Date(year, month, 0).getDate()}`;

    const shiftEnd = String(
        settings?.shiftEndTime || "06:00 PM"
    ).trim();

    function getShiftEndMinutes(value) {
        const match = value.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);

        if (!match) return 18 * 60;

        let hours = Number(match[1]);
        const minutes = Number(match[2]);
        const period = match[3].toUpperCase();

        if (hours === 12) hours = 0;
        if (period === "PM") hours += 12;

        return hours * 60 + minutes;
    }

    function shiftHasEnded(dateString) {
        if (dateString < todayDate) return true;
        if (dateString > todayDate) return false;

        const currentMinutes =
            today.getHours() * 60 + today.getMinutes();

        return currentMinutes >= getShiftEndMinutes(shiftEnd);
    }

    const employeeEmail =
        String(employee.email || "").trim().toLowerCase();

    const employeeName =
        String(employee.name || "").trim().toLowerCase();

    const attendance = Array.isArray(attendanceRecords)
        ? attendanceRecords
        : [];

    const leaveList = Array.isArray(approvedLeaves)
        ? approvedLeaves
        : [];

    const holidayDates = new Set(
        (Array.isArray(holidays) ? holidays : [])
            .map(item => String(item.date || "").slice(0, 10))
    );

    const approvedLeaveDates = new Set();

    for (const leave of leaveList) {
        if (
            String(leave.status || "").toUpperCase() !== "APPROVED" ||
            String(leave.name || "").trim().toLowerCase() !== employeeName ||
            !leave.startDate ||
            !leave.endDate
        ) {
            continue;
        }

        const start = String(leave.startDate).slice(0, 10);
        const end = String(leave.endDate).slice(0, 10);

        const isHalfDay = /half.?day/i.test(
            `${leave.duration || ""} ${leave.dayType || ""} ${leave.type || ""}`
        );

        for (
            let date = new Date(`${start}T00:00:00Z`);
            date <= new Date(`${end}T00:00:00Z`);
            date.setUTCDate(date.getUTCDate() + 1)
        ) {
            const dateString = date.toISOString().slice(0, 10);

            if (
                dateString >= monthStart &&
                dateString <= monthEnd &&
                !isHalfDay
            ) {
                approvedLeaveDates.add(dateString);
            }
        }
    }

    const absentDates = [];

    for (
        let date = new Date(`${monthStart}T00:00:00Z`);
        date <= new Date(`${monthEnd}T00:00:00Z`);
        date.setUTCDate(date.getUTCDate() + 1)
    ) {
        const dateString = date.toISOString().slice(0, 10);
        const weekday = date.getUTCDay();

        // Sunday is the weekly off.
        if (weekday === 0) continue;

        // Do not mark a future date or today's unfinished shift absent.
        if (!shiftHasEnded(dateString)) continue;

        // Holidays and approved full-day leaves are not absences.
        if (holidayDates.has(dateString)) continue;
        if (approvedLeaveDates.has(dateString)) continue;

        // Do not count days before the employee joined.
        const joiningDate = parseJoiningDate(employee.joiningDate);
        if (joiningDate) {
            const joined = new Date(joiningDate);
            const joinedDate =
                `${joined.getFullYear()}-${pad(joined.getMonth() + 1)}-${pad(joined.getDate())}`;

            if (dateString < joinedDate) continue;
        }

        const record = attendance.find(item =>
            String(item.email || "").trim().toLowerCase() === employeeEmail &&
            String(item.date || "").slice(0, 10) === dateString
        );

        const checkIn = String(record?.checkInTime || "").trim();
        const checkOut = String(record?.checkOutTime || "").trim();

        const validCheckIn =
            checkIn !== "" &&
            checkIn !== "--:--" &&
            checkIn.toLowerCase() !== "pending";

        const validCheckOut =
            checkOut !== "" &&
            checkOut !== "--:--" &&
            checkOut.toLowerCase() !== "pending";

        // Missing either punch means absent.
        if (!validCheckIn || !validCheckOut) {
            absentDates.push(dateString);
        }
    }

    return {
        absentDays: absentDates.length,
        absentDates
    };
}

async function readDb() {
    const [rows] = await pool.execute(
        'SELECT data FROM hr_portal_store WHERE id = 1'
    );

    if (!rows.length) {
        throw new Error('HR Portal data row is missing from MySQL.');
    }

    const data = typeof rows[0].data === 'string'
        ? JSON.parse(rows[0].data)
        : rows[0].data;

    if (!data || typeof data !== 'object' || !Array.isArray(data.users)) {
        throw new Error('Invalid HR Portal data in MySQL.');
    }

    return {
        users: [],
        attendance: [],
        leaves: [],
        myLeaves: [],
        holidays: [],
        payroll: [],
        departments: [],
        settings: {},
        ...data
    };
}

async function writeDb(newData) {
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [rows] = await connection.execute(
            'SELECT data FROM hr_portal_store WHERE id = 1 FOR UPDATE'
        );

        if (!rows.length) {
            throw new Error('HR Portal MySQL data row is missing.');
        }

        const existing = typeof rows[0].data === 'string'
            ? JSON.parse(rows[0].data)
            : rows[0].data;

        // Protect existing records against accidental removal.
        for (const field of ['users', 'attendance', 'payroll']) {
            if (
                Array.isArray(existing[field]) &&
                existing[field].length > 0 &&
                (!Array.isArray(newData[field]) ||
                 newData[field].length < existing[field].length)
            ) {
                console.warn(`Safety lock: preserving ${field} records.`);
                newData[field] = existing[field];
            }
        }

        await connection.execute(
            'UPDATE hr_portal_store SET data = ? WHERE id = 1',
            [JSON.stringify(newData)]
        );

        await connection.commit();
        console.log('HR Portal data saved to MySQL successfully.');
    } catch (error) {
        await connection.rollback();
        console.error('MySQL write failed:', error.message);
        throw error;
    } finally {
        connection.release();
    }
}

async function saveAttendanceSafely(newAttendance) {
    const db = await readDb();
    const oldAttendance = Array.isArray(db.attendance) ? db.attendance : [];
    const incoming = Array.isArray(newAttendance) ? newAttendance : [newAttendance];

    db.attendance = [...incoming, ...oldAttendance];
    await writeDb(db);
    return db.attendance;
}// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'views'), { index: false }));

// --- SESSION CONFIGURATION ---
app.use(session({
    secret: 'clickormedia-hr-portal-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // Session valid for 24 hours
}));

// Set EJS view engine
app.engine('html', require('ejs').renderFile);
app.set('view engine', 'html');
app.set('views', path.join(__dirname, 'views'));

// Nodemailer Transporter Configuration (Update with your email & app password)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'your-email@gmail.com',    // Replace with your email address
        pass: 'your-app-password-here'    // Replace with your Google App Password
    }
});

// --- ROUTES ---

// 1. Root Route (Login page)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

// Login page route
app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'login.html'));
});


// 1. Password Update Route (Directly updates user password in MongoDB)
app.post('/api/employee/update-password', async (req, res) => {
    try {
        const { newPassword } = req.body;
        if (!newPassword || newPassword.length < 6) {
            return res.status(400).json({ success: false, message: "Password must be at least 6 characters long." });
        }
       
        const db = await readDb();
        if (!db.users) db.users = [];
       
        let userEmail = req.session.user ? req.session.user.email : "pranchal@clickormedia.co.in";
        let user = db.users.find(u => u.email && u.email.toLowerCase() === userEmail.toLowerCase());
       
        if (!user && db.users.length > 0) {
            user = db.users[0];
        }
       
        if (user) {
            user.password = newPassword;
            await writeDb(db);
            console.log(`--- PASSWORD UPDATED IN MONGODB FOR ${user.name} ---`);
            return res.json({ success: true, message: "Password updated successfully" });
        } else {
            return res.status(404).json({ success: false, message: "User not found in database" });
        }
    } catch (err) {
        console.error('Critical error updating password:', err);
        res.status(500).json({ success: false, message: "Server error while updating password." });
    }
});
// HR-only password change route
app.post('/api/hr/update-password', async (req, res) => {
    try {
        // Only a logged-in HR/admin user can change their password.
        if (!req.session.user || req.session.user.role !== 'admin') {
            return res.status(401).json({
                success: false,
                message: 'Please log in with your HR account.'
            });
        }

        const { currentPassword, newPassword, confirmPassword } = req.body;

        if (!currentPassword || !newPassword || !confirmPassword) {
            return res.status(400).json({
                success: false,
                message: 'Please fill in all password fields.'
            });
        }

        if (newPassword.length < 8) {
            return res.status(400).json({
                success: false,
                message: 'Your new password must be at least 8 characters long.'
            });
        }

        if (newPassword !== confirmPassword) {
            return res.status(400).json({
                success: false,
                message: 'New password and confirmation do not match.'
            });
        }

        if (currentPassword === newPassword) {
            return res.status(400).json({
                success: false,
                message: 'Your new password must be different from your current password.'
            });
        }

        const db = await readDb();

        const email = req.session.user.email.trim().toLowerCase();

        const user = db.users.find(
            u => u.email && u.email.trim().toLowerCase() === email
        );

        if (!user || user.role !== 'admin') {
            return res.status(404).json({
                success: false,
                message: 'HR account not found.'
            });
        }

        const storedPassword = String(user.password || '');
        const isBcryptHash = /^\$2[aby]\$\d{2}\$/.test(storedPassword);

        const passwordIsCorrect = isBcryptHash
            ? await bcrypt.compare(currentPassword, storedPassword)
            : storedPassword === currentPassword;

        if (!passwordIsCorrect) {
            return res.status(400).json({
                success: false,
                message: 'Your current password is incorrect.'
            });
        }

        user.password = await bcrypt.hash(newPassword, 12);

        await writeDb(db);

        return res.json({
            success: true,
            message: 'Password changed successfully.'
        });

    } catch (err) {
        console.error('HR password update failed:', err);

        return res.status(500).json({
            success: false,
            message: 'Unable to change password. Please try again.'
        });
    }
});
// 2. Strict Login Verification Route with Role-Based Redirection
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const db = await readDb();
       
        const submittedEmail = (email || "").trim().toLowerCase();

const user = Array.isArray(db.users)
    ? db.users.find(u =>
        u.email &&
        u.email.trim().toLowerCase() === submittedEmail
      )
    : null;

const storedPassword = String(user?.password || '');
const isBcryptHash = /^\$2[aby]\$\d{2}\$/.test(storedPassword);

const passwordMatches = user
    ? (
        isBcryptHash
            ? await bcrypt.compare(password || '', storedPassword)
            : storedPassword === password
      )
    : false;

console.log("[LOGIN DIAGNOSTIC]", {
    usersArrayExists: Array.isArray(db.users),
    usersCount: Array.isArray(db.users) ? db.users.length : 0,
    emailFound: Boolean(user),
    passwordMatches,
    role: user ? user.role : null
});

if (user && passwordMatches) {
        req.session.user = { name: user.name, email: user.email, role: user.role };
           
            let redirectUrl = "/employee/dashboard";
            if (user.role === 'admin') {
                redirectUrl = "/hr/dashboard";
            }
           
            return res.json({ success: true, redirectUrl: redirectUrl });
        } else {
            return res.status(401).json({ success: false, message: "Invalid email or password." });
        }
    } catch (err) {
        console.error('Error during login:', err);
        return res.status(500).json({ success: false, message: "Server error during login." });
    }
});

// --- LOGOUT API ROUTE ---
app.post('/api/auth/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Could not log out, please try again.' });
        }
        res.clearCookie('connect.sid');
        return res.json({ success: true, message: 'Logged out successfully' });
    });
});

// 3. HR Dashboard Route
app.get('/hr/dashboard', (req, res) => {
    try {
        res.sendFile(path.join(__dirname, 'views', 'index.html'));
    } catch(err) {
        console.error('Error loading dashboard:', err);
        res.status(500).send('Server Error');
    }
});

// 4. Employee Directory Page Route
app.get('/hr/employees', async (req, res) => {
    try {
        const db = await readDb();
        const employees = db.users ? db.users.filter(u => (u.role === 'employee' || u.role === 'admin') && u.name.toLowerCase() !== 'robin') : [];
        const exEmployees = db.users ? db.users.filter(u => u.role === 'former') : [];
       
        res.render('employee', { employees, exEmployees });
    } catch (err) {
        console.error('Error fetching employees page:', err);
        res.status(500).send('Server Error');
    }
});

// --- API: Get Total Employee Count for Dashboard Stats ---
app.get('/api/hr/stats', async (req, res) => {
    try {
        const db = await readDb();
        const activeUsers = db.users ? db.users.filter(u => u.role !== 'former' && u.name.toLowerCase() !== 'robin') : [];
       
        res.json({
            success: true,
            totalEmployees: activeUsers.length > 0 ? activeUsers.length : 4
        });
    } catch (err) {
        console.error('Error fetching HR stats:', err);
        res.status(500).json({ success: false, totalEmployees: 0 });
    }
});

// API: Get Active Employees
// API: Get Active Employees with Default Performance Check
app.get('/api/employees/active', async (req, res) => {
    try {
        const db = await readDb();
        if (db.users) {
            // Ensure every active user has a default performance field if missing
            db.users.forEach(u => {
                if (!u.performance) {
                    u.performance = 'GOOD';
                }
            });
            await writeDb(db);
        }
        const activeEmployees = db.users ? db.users.filter(u => (u.role === 'employee' || u.role === 'admin') && u.name.toLowerCase() !== 'robin') : [];
        res.json({ success: true, employees: activeEmployees });
    } catch (err) {
        res.status(500).json({ success: false, employees: [] });
    }
});// 5. API: Add New Employee
app.post('/api/employees/add', async (req, res) => {
    try {
        const { name, email, department, designation, phone } = req.body;
        const db = await readDb();
        if (!db.users) db.users = [];

        const newEmployee = {
            _id: Date.now().toString(),
            name,
            email,
            password: 'defaultpassword123',
            role: 'employee',
            department: department || 'Engineering',
            designation: designation || 'Staff',
            phone: phone || '',
            performance: 'GOOD',
            avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&h=80&fit=crop&crop=faces'
        };

        db.users.push(newEmployee);
        await writeDb(db);

        console.log(`--- PERMANENTLY ADDED: ${name} ---`);
        res.json({ success: true, message: 'Employee added successfully!' });
    } catch (err) {
        console.error('Error adding employee:', err);
        res.status(500).json({ success: false, message: 'Server error while adding employee' });
    }
});

// --- API: Update Employee Performance Permanently ---
app.post('/api/employees/update-performance', async (req, res) => {
    try {
        const { name, performance } = req.body;
        const db = await readDb();
        if (!db.users) db.users = [];

        // Name se employee ko find karein
        let user = db.users.find(u => u.name && u.name.toLowerCase() === (name || "").toLowerCase());
        if (user) {
            user.performance = performance;
            await writeDb(db);
            console.log(`--- PERFORMANCE UPDATED FOR ${user.name}: ${performance} ---`);
            return res.json({ success: true, message: 'Performance updated successfully!' });
        } else {
            return res.status(404).json({ success: false, message: 'Employee not found in database.' });
        }
    } catch (err) {
        console.error('Error updating performance:', err);
        res.status(500).json({ success: false, message: 'Server error while updating performance' });
    }
});// 6. API: Archive Employee
app.delete('/api/employees/:id', async (req, res) => {
    try {
        const empId = req.params.id;
        const db = await readDb();

        if (db.users) {
            const user = db.users.find(u => u._id === empId || u.email === empId);
            if (user) {
                user.role = 'former';
               
                if (db.attendance) {
                    db.attendance = db.attendance.filter(log => log.email.toLowerCase() !== user.email.toLowerCase());
                }

                if (db.leaves) {
                    db.leaves = db.leaves.filter(leave => leave.email && leave.email.toLowerCase() !== user.email.toLowerCase());
                }

                await writeDb(db);
                console.log(`--- PERMANENTLY REMOVED & SYNCED ACROSS ALL MODULES: ${user.name} ---`);
            }
        }

        res.json({ success: true, message: 'Employee archived and synced successfully!' });
    } catch (err) {
        console.error('Error archiving employee:', err);
        res.status(500).json({ success: false, message: 'Server error while archiving employee' });
    }
});

//7.
// 7. API: Get Attendance Logs (Safe & Non-destructive)
// --- API: Get All Attendance Logs for Attendance Page ---
app.get('/api/attendance', async (req, res) => {
    try {
        const db = await readDb();
        res.json({ success: true, attendance: db.attendance || [] });
    } catch (err) {
        res.status(500).json({ success: false, attendance: [] });
    }
});// 8. API: Save Manual Attendance Log
app.post('/api/attendance/add', async (req, res) => {
    try {
        const { name, email, dept, role, date, checkInTime, checkInLoc, checkOutTime, checkOutLoc, status, avatar } = req.body;
        const db = await readDb();
        if (!db.attendance) db.attendance = [];

        const newLog = { name, email, dept, role, date: date || '2026-09-28', checkInTime, checkInLoc, checkOutTime, checkOutLoc, status, avatar };
        db.attendance.unshift(newLog);
        await writeDb(db);

        console.log(`--- ATTENDANCE LOG RECORDED FOR ${name} ON ${date} ---`);
        res.json({ success: true, message: 'Attendance recorded successfully!' });
    } catch (err) {
        console.error('Error saving attendance:', err);
        res.status(500).json({ success: false, message: 'Server error while saving attendance' });
    }
});
// --- API: Get Today's Attendance Summary for HR Dashboard ---
// --- API: Get Today's Attendance Summary for HR Dashboard ---
app.get('/api/hr/attendance-today', async (req, res) => {
    try {
        const db = await readDb();
        const attendanceList = db.attendance || [];
        const activeUsers = db.users ? db.users.filter(u => u.role !== 'former' && u.name.toLowerCase() !== 'robin') : [];
        const totalEmployees = activeUsers.length > 0 ? activeUsers.length : 5; // Total active employees (Jaise dashboard pe 5 hain)

        // Aaj ki date (YYYY-MM-DD format)
        const todayDate = new Date().toISOString().split('T')[0];

        // Sabse latest date find karein jo database me available ho (taaki agar aaj entry na mile toh latest wali dikhe)
        let targetDate = todayDate;
        if (attendanceList.length > 0) {
            // Agar aaj ki date ka koi log nahi hai, toh list ka sabse pehla/latest date utha lo
            const hasTodayLogs = attendanceList.some(log => log.date === todayDate);
            if (!hasTodayLogs) {
                targetDate = attendanceList[0].date;
            }
        }

        // Us target date ke saare attendance logs filter karein
        const todayLogs = attendanceList.filter(log => log.date === targetDate);

        let presentCount = todayLogs.length;
        let lateCount = todayLogs.filter(log => log.status && log.status.toLowerCase().includes('late')).length;
        let absentCount = Math.max(0, totalEmployees - presentCount);

        // Percentage calculate karein
        let percentage = totalEmployees > 0 ? Math.round((presentCount / totalEmployees) * 100) : 100;

        res.json({
            success: true,
            percentage: percentage,
            late: lateCount,
            absent: absentCount
        });
    } catch (err) {
        console.error('Error fetching today attendance:', err);
        res.status(500).json({ success: false, percentage: 0, late: 0, absent: 0 });
    }
});
// --- API: Get Employee Specific Attendance Logs ---

app.get('/api/employee/attendance', async (req, res) => {
    try {
        if (!req.session.user || !req.session.user.email) {
            return res.status(401).json({
                success: false,
                attendance: []
            });
        }

        const email = req.session.user.email.trim().toLowerCase();
        const db = await readDb();
        const attendance = Array.isArray(db.attendance) ? db.attendance : [];

        const userLogs = attendance.filter(log =>
            log.email &&
            log.email.trim().toLowerCase() === email
        );

        return res.json({
            success: true,
            attendance: userLogs
        });
    } catch (err) {
        console.error('Error fetching employee attendance:', err);
        return res.status(500).json({
            success: false,
            attendance: []
        });
    }
});
// 9. API: Get Settings / Office Timings
app.get('/api/settings', async (req, res) => {
    try {
        const db = await readDb();
        if (!db.settings || !db.settings.shiftStartTime) {
            db.settings = {
                shiftStartTime: "09:30 AM",
                shiftEndTime: "06:30 PM",
                gracePeriod: "15",
                companyName: "CLICKORMEDIA PRIVATE LIMITED",
                cin: "U72900DL2024PTC123456",
                hrEmail: "hr@clickormedia.co.in",
                location: "Sanat Nagar, Jammu & Kashmir, India",
                paidLeaves: 18,
                casualLeaves: 12,
                sickLeaves: 10
            };
            await writeDb(db);
        }
        res.json({ success: true, settings: db.settings });
    } catch (err) {
        res.status(500).json({ success: false, settings: { shiftStartTime: "09:30 AM", shiftEndTime: "06:30 PM", gracePeriod: "15" } });
    }
});

// 10. API: Save Office Timings Permanently
app.post('/api/settings/update', async (req, res) => {
    try {
        const { shiftStartTime, shiftEndTime, gracePeriod } = req.body;
        const db = await readDb();
       
        if (!db.settings) db.settings = {};
       
        db.settings.shiftStartTime = shiftStartTime || "09:30 AM";
        db.settings.shiftEndTime = shiftEndTime || "06:30 PM";
        db.settings.gracePeriod = gracePeriod || "15";

        await writeDb(db);
        res.json({ success: true, message: 'Settings saved permanently!' });
    } catch (err) {
        console.error('Error saving settings:', err);
        res.status(500).json({ success: false, message: 'Server error while saving settings' });
    }
});

// --- LEAVE MANAGEMENT APIS ---
app.get('/api/leaves', async (req, res) => {
    try {
        if (!req.session?.user?.email) {
            return res.status(401).json({
                success: false,
                message: 'Please log in again.',
                leaves: [],
                myLeaves: []
            });
        }

        const db = await readDb();
        const email = req.session.user.email.toLowerCase();

        const allLeaves = Array.isArray(db.leaves) ? db.leaves : [];

        const myLeaves = allLeaves.filter(leave =>
            leave.email &&
            leave.email.toLowerCase() === email
        );

        return res.json({
            success: true,
            leaves: myLeaves,
            myLeaves: myLeaves
        });
    } catch (err) {
        console.error('Error fetching employee leaves:', err);
        return res.status(500).json({
            success: false,
            leaves: [],
            myLeaves: []
        });
    }
});
app.get('/api/employee/leaves', async (req, res) => {
    try {
        if (!req.session.user || !req.session.user.email) {
            return res.status(401).json({
                success: false,
                myLeaves: []
            });
        }

        const db = await readDb();
        const email = req.session.user.email.trim().toLowerCase();

        const userLeaves = (Array.isArray(db.leaves) ? db.leaves : [])
            .filter(leave =>
                leave.email &&
                leave.email.trim().toLowerCase() === email
            );

        return res.json({
            success: true,
            myLeaves: userLeaves
        });
    } catch (err) {
        console.error('Error fetching employee leaves:', err);
        return res.status(500).json({
            success: false,
            myLeaves: []
        });
    }
});
app.get('/api/hr/leaves', async (req, res) => {
    try {
        const db = await readDb();
        res.json({ success: true, leaves: db.leaves || [] });
    } catch (err) {
        res.status(500).json({ success: false, leaves: [] });
    }
});

app.post('/api/leaves/update', async (req, res) => {
    try {
        const { id, status } = req.body;
        const db = await readDb();
        if (!db.leaves) db.leaves = [];
        if (!db.myLeaves) db.myLeaves = [];

        let currentTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        let hrItem = db.leaves.find(l => l.id == id);
        if (hrItem) {
            hrItem.status = status;
            hrItem.updatedAt = currentTime;
        }

        let empItem = db.myLeaves.find(l => l.id == id);
        if (empItem) {
            empItem.status = status;
            empItem.updatedAt = currentTime;
        } else if (hrItem) {
            db.myLeaves.unshift(hrItem);
        }

        await writeDb(db);
        res.json({ success: true, message: 'Status updated successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});


app.post('/api/leaves/apply', async (req, res) => {
    try {
        const { type, duration, reason, name, startDate, endDate } = req.body;
        const db = await readDb();

        if (!db.leaves) db.leaves = [];
        if (!db.myLeaves) db.myLeaves = [];

        const applicantName =
            (req.session.user && req.session.user.name) ||
            name ||
            "Pranchal Rajpal";

        const applicantEmail =
            (req.session.user && req.session.user.email) ||
            "pranchal@clickormedia.co.in";

        const currentTime = new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });

        const newSub = {
            id: Date.now(),
            name: applicantName,
            email: applicantEmail,
            type: type || 'Leave',
            duration: duration || '',
            startDate: startDate || null,
            endDate: endDate || null,
            reason: reason || '',
            status: 'PENDING',
            paidStatus: null,
            updatedAt: currentTime,
            avatar: "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&h=80&fit=crop&crop=faces"
        };

        db.leaves.unshift(newSub);
        db.myLeaves.unshift(newSub);

        await writeDb(db);

        console.log(`Leave application saved for ${applicantName}`);

        res.json({
            success: true,
            message: 'Leave application submitted successfully!'
        });
    } catch (err) {
        console.error('Error applying leave:', err);
        res.status(500).json({
            success: false,
            message: 'Server error while applying leave'
        });
    }
});
// --- HOLIDAY APIS ---
app.get('/api/holidays', async (req, res) => {
    try {
        const db = await readDb();
        if (!db.holidays || db.holidays.length === 0) {
            db.holidays = [
                { date: "2026-01-26", day: "Monday", name: "Republic Day", category: "National Holiday" },
                { date: "2026-03-04", day: "Wednesday", name: "Holi", category: "Festival" },
                { date: "2026-03-31", day: "Tuesday", name: "Id-ul-Fitr", category: "Festival" },
                { date: "2026-04-14", day: "Tuesday", name: "Ambedkar Jayanti", category: "Optional Leave" },
                { date: "2026-05-01", day: "Friday", name: "ClickOrMedia Annual Tech Meet", category: "Company Event" },
                { date: "2026-08-15", day: "Saturday", name: "Independence Day", category: "National Holiday" },
                { date: "2026-08-28", day: "Friday", name: "Raksha Bandhan", category: "Optional Leave" },
                { date: "2026-09-04", day: "Friday", name: "Janmashtami", category: "Festival" },
                { date: "2026-10-02", day: "Friday", name: "Mahatma Gandhi Jayanti", category: "National Holiday" },
                { date: "2026-10-20", day: "Tuesday", name: "Dussehra", category: "Festival" },
                { date: "2026-11-08", day: "Sunday", name: "Diwali", category: "Festival" },
                { date: "2026-12-25", day: "Friday", name: "Christmas Day", category: "Festival" }
            ];
            await writeDb(db);
        }
        res.json({ success: true, holidays: db.holidays });
    } catch (err) {
        res.status(500).json({ success: false, holidays: [] });
    }
});

app.post('/api/holidays/add', async (req, res) => {
    try {
        const { date, day, name, category } = req.body;
        const db = await readDb();
        if (!db.holidays) db.holidays = [];

        db.holidays.push({ date, day, name, category });
        db.holidays.sort((a, b) => new Date(a.date) - new Date(b.date));
        await writeDb(db);

        res.json({ success: true, message: 'Holiday added successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.delete('/api/holidays/:index', async (req, res) => {
    try {
        const index = parseInt(req.params.index);
        const db = await readDb();
        if (db.holidays && db.holidays[index]) {
            db.holidays.splice(index, 1);
            await writeDb(db);
        }
        res.json({ success: true, message: 'Holiday deleted successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Page Routes
app.get('/hr/attendance', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'attendance.html'));
});

app.get('/hr/leaves', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'leaves.html'));
});

app.get('/hr/holidaycalendar', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'holidaycalendar.html'));
});

// --- ANALYTICS PERSISTENCE API ---
app.get('/api/analytics', async (req, res) => {
    try {
        const db = await readDb();
        const activeUsers = db.users ? db.users.filter(u => (u.role === 'employee' || u.role === 'admin') && u.name.toLowerCase() !== 'robin') : [];
       
        const deptCounts = {};
        activeUsers.forEach(user => {
            const dept = user.department || 'Engineering';
            deptCounts[dept] = (deptCounts[dept] || 0) + 1;
        });

        res.json({
            success: true,
            activeHeadcount: activeUsers.length,
            departments: deptCounts
        });
    } catch (err) {
        res.status(500).json({ success: false, activeHeadcount: 0, departments: {} });
    }
});

app.get('/hr/analytics', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'analytics.html'));
});

// --- PAYROLL PERSISTENCE API (Robin removed) ---
app.get('/api/payroll', async (req, res) => {
    try {
        const db = await readDb();
        if (!db.payroll || db.payroll.length === 0) {
           db.payroll = [
    {
        id: 1,
        name: "Tanya Dua",
        email: "tanya@clickormedia.co.in",
        dept: "HR & Finance",
        baseNum: 16000,
        previousSalary: 16000,
        leaveBalance: 5,
        halfDays: 0,
        status: "PAID",
        joiningDate: "01 July 2026",
        leaveLogs: [],
        avatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&h=100&fit=crop&crop=faces"
    },
    {
        id: 2,
        name: "Pranchal Rajpal",
        email: "pranchal@clickormedia.co.in",
        dept: "IT",
        baseNum: 23000,
        previousSalary: 23000,
        leaveBalance: 4,
        halfDays: 0,
        status: "PAID",
        joiningDate: "01 September 2026",
        leaveLogs: [],
        avatar: "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&h=80&fit=crop&crop=faces"
    },
    {
        id: 3,
        name: "Anshdeep",
        email: "anshdeep@clickormedia.co.in",
        dept: "Design",
        baseNum: 16000,
        previousSalary: 16000,
        leaveBalance: 6,
        halfDays: 0,
        status: "PAID",
        joiningDate: "18 September 2026",
        leaveLogs: [],
        avatar: "https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?w=80&h=80&fit=crop&crop=faces"
    },
    {
        id: 4,
        name: "Sukhi",
        email: "sukhi@clickormedia.co.in",
        dept: "Design",
        baseNum: 25000,
        previousSalary: 25000,
        leaveBalance: 3,
        halfDays: 0,
        status: "PAId",
        joiningDate: "04 September 2026",
        leaveLogs: [],
        avatar: "https://images.unsplash.com/photo-1580489944761-15a19d654956?w=80&h=80&fit=crop&crop=faces"
    }
];
            await writeDb(db);
        }
// Update existing records with correct departments and joining dates
        let correctDetails = {
            "Tanya Dua": { dept: "UI/UX Designer", joiningDate: "01 July 2026" },
            "Pranchal Rajpal": { dept: "Engineering", joiningDate: "01 September 2026" },
            "Anshdeep": { dept: "Design", joiningDate: "18 September 2026" },
            "Sukhi": { dept: "Design", joiningDate: "04 September 2026" }
        };

        let updatedFlag = false;
        db.payroll.forEach(rec => {
            if (correctDetails[rec.name]) {
                if (rec.dept !== correctDetails[rec.name].dept || rec.joiningDate !== correctDetails[rec.name].joiningDate) {
                    rec.dept = correctDetails[rec.name].dept;
                    rec.joiningDate = correctDetails[rec.name].joiningDate;
                    updatedFlag = true;
                }
            }
        });

        if (updatedFlag) {
            await writeDb(db);
        }
        const activeUsers = db.users ? db.users.filter(u => u.role !== 'former' && u.name.toLowerCase() !== 'robin') : [];
        const activeEmails = activeUsers.map(u => u.email.toLowerCase());

       
  const filteredPayroll = db.payroll
    .filter(rec =>
        activeEmails.includes((rec.email || '').toLowerCase()) &&
        (rec.name || '').toLowerCase() !== 'robin'
    )
    .map(rec => {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1;

    
        const leave = calculateMonthlyLeave(
            rec,
            db.leaves || [],
            year,
            month
        );

        const absence = calculateMonthlyAbsences(
            rec,
            db.attendance || [],
            db.leaves || [],
            db.holidays || [],
            db.settings || {},
            year,
            month
        );


  return {
    ...rec,
    earnedLeaves: leave.earned,
    leavesUsedThisMonth: leave.used,
    paidLeavesUsed: leave.paidUsed,
    unpaidLeaves: leave.unpaid,
    
    unpaidHalfDays: leave.unpaidHalfDays,
    calculatedLeaveBalance: leave.balance,
    absentDays: absence.absentDays,
    absentDates: absence.absentDates
};

    });

res.json({ success: true, payroll: filteredPayroll });
    } catch (err) {
        res.status(500).json({ success: false, payroll: [] });
    }
});

app.get('/api/debug/employee-leaves', async (req, res) => {
    try {
        const db = await readDb();

        const employeeName = String(req.query.name || "Tanya Dua")
            .trim()
            .toLowerCase();

        const payrollRecords = (
            Array.isArray(db.payroll) ? db.payroll : []
        ).filter(record =>
            String(record.name || "").trim().toLowerCase() === employeeName
        );

        const allLeaveArrays = Object.keys(db)
            .filter(key => /leave/i.test(key))
            .map(key => ({
                key,
                count: Array.isArray(db[key]) ? db[key].length : null,
                records: Array.isArray(db[key])
                    ? db[key].filter(item =>
                        String(item.name || "")
                            .trim().toLowerCase() === employeeName
                    ).map(item => ({
                        id: item.id,
                        name: item.name,
                        startDate: item.startDate,
                        endDate: item.endDate,
                        duration: item.duration,
                        dayType: item.dayType,
                        status: item.status
                    }))
                    : []
            }));

        res.json({
            success: true,
            databaseKeys: Object.keys(db),
            employee: employeeName,
            payrollRecords: payrollRecords.map(record => ({
                name: record.name,
                email: record.email,
                joiningDate: record.joiningDate,
                leaveBalance: record.leaveBalance,
                leaveLogs: record.leaveLogs
            })),
            leaveArrays: allLeaveArrays
        });
    } catch (err) {
        console.error("Debug employee leaves error:", err);
        res.status(500).json({
            success: false,
            message: "Could not inspect employee records"
        });
    }
});
app.post('/api/payroll/update-status', async (req, res) => {
    try {
        const { id, status } = req.body;

        const allowedStatuses = ['PAID', 'PENDING'];

        if (!allowedStatuses.includes(String(status || '').toUpperCase())) {
            return res.status(400).json({
                success: false,
                message: 'Invalid payroll status.'
            });
        }

        const db = await readDb();
        if (!Array.isArray(db.payroll)) db.payroll = [];

        const normalizedStatus = String(status).toUpperCase();
        const changedAt = new Date().toISOString();

        if (id === 'all') {
            db.payroll.forEach(record => {
                record.status = normalizedStatus;
                record.statusUpdatedAt = changedAt;
                record.statusUpdatedBy =
                    req.session?.user?.email || 'HR';
            });
        } else {
            const record = db.payroll.find(item => item.id == id);

            if (!record) {
                return res.status(404).json({
                    success: false,
                    message: 'Payroll record not found.'
                });
            }

            record.status = normalizedStatus;
            record.statusUpdatedAt = changedAt;
            record.statusUpdatedBy =
                req.session?.user?.email || 'HR';
        }

        await writeDb(db);

        res.json({
            success: true,
            message: 'Payroll status updated successfully!'
        });
    } catch (err) {
        console.error('Error updating payroll status:', err);

        res.status(500).json({
            success: false,
            message: 'Server error while updating payroll status.'
        });
    }
});
app.post('/api/payroll/update-attendance', async (req, res) => {
    try {
        const { id, leaveBalance, halfDays } = req.body;
        const db = await readDb();
        if (!db.payroll) db.payroll = [];

        let rec = db.payroll.find(r => r.id == id);
        if (rec) {
            rec.leaveBalance = parseFloat(leaveBalance);
            rec.halfDays = parseFloat(halfDays);
            await writeDb(db);
            res.json({ success: true, message: 'Attendance records updated successfully!' });
        } else {
            res.status(404).json({ success: false, message: 'Record not found' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/hr/payroll', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'payroll.html'));
});

app.post('/api/payroll/update-salary', async (req, res) => {
    try {
        const { id, baseNum } = req.body;
        const db = await readDb();
        if (!db.payroll) db.payroll = [];

        let rec = db.payroll.find(r => r.id == id);
        if (rec) {
            // Agar pehle se salary hai toh use previousSalary mein save kar do
            if (rec.baseNum && rec.baseNum !== parseFloat(baseNum)) {
                rec.previousSalary = rec.baseNum;
            }
            rec.baseNum = parseFloat(baseNum);
           
            await writeDb(db);
            res.json({ success: true, message: 'Salary updated and history saved successfully!' });
        } else {
            res.status(404).json({ success: false, message: 'Record not found' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});
app.post('/api/payroll/add-leave-log', async (req, res) => {
    try {
        const { id, type, reason, date, day, isHalfDay } = req.body;
        const db = await readDb();
        if (!db.payroll) db.payroll = [];

        let rec = db.payroll.find(r => r.id == id);
        if (rec) {
            if (!rec.leaveLogs) rec.leaveLogs = [];
           
            rec.leaveLogs.push({
                date: date || new Date().toISOString().split('T')[0],
                day: day || 'Workday',
                type: type || 'Unpaid Leave',
                reason: reason || 'Manual HR Entry'
            });

            if (isHalfDay) {
                rec.halfDays = (rec.halfDays || 0) + 0.5;
            }

            await writeDb(db);
            res.json({ success: true, message: 'Leave log and attendance penalty updated successfully!' });
        } else {
            res.status(404).json({ success: false, message: 'Record not found' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/payroll/delete-leave-log', async (req, res) => {
    try {
        const { id, logIndex } = req.body;
        const db = await readDb();
        if (!db.payroll) db.payroll = [];

        let rec = db.payroll.find(r => r.id == id);
        if (rec && rec.leaveLogs) {
            let removedLog = rec.leaveLogs.splice(logIndex, 1)[0];
           
            if (removedLog && removedLog.type.includes('Half-Day') && rec.halfDays > 0) {
                rec.halfDays = Math.max(0, rec.halfDays - 0.5);
            }

            await writeDb(db);
            res.json({ success: true, message: 'Leave log removed successfully!' });
        } else {
            res.status(404).json({ success: false, message: 'Record or log not found' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// --- DEPARTMENTS PERSISTENCE API ---
app.get('/api/departments', async (req, res) => {
    try {
        const db = await readDb();
       
        if (!db.departments || db.departments.length === 0) {
            let creativeMembers = ["Tanya Dua", "Anshdeep", "Sukhi"];
            let itMembers = ["Pranchal Rajpal"];

            const calculateTeamBudget = (memberNames) => {
                if (!db.payroll) return "₹0";
                let total = db.payroll
                    .filter(p => memberNames.includes(p.name))
                    .reduce((sum, p) => sum + (p.baseNum || 0), 0);
                return "₹" + total.toLocaleString('en-IN');
            };

            db.departments = [
                {
                    id: 1,
                    name: "Creative Team",
                    lead: "Tanya Dua",
                    staff: creativeMembers.length,
                    budget: calculateTeamBudget(creativeMembers),
                    icon: "fa-pen-nib",
                    color: "bg-purple-50 text-purple-600",
                    members: [
                        { name: "Tanya Dua", email: "tanya@clickormedia.co.in", role: "HR Manager" },
                        { name: "Anshdeep", email: "anshdeep@clickormedia.co.in", role: " Video Editor" },
                        { name: "Sukhi", email: "sukhi@clickormedia.co.in", role: " Videographer" }
                    ]
                },
                {
                    id: 2,
                    name: "IT Team",
                    lead: "Pranchal Rajpal",
                    staff: itMembers.length,
                    budget: calculateTeamBudget(itMembers),
                    icon: "fa-code",
                    color: "bg-blue-50 text-blue-600",
                    members: [
                        { name: "Pranchal Rajpal", email: "pranchal@clickormedia.co.in", role: "IT" }
                    ]
                }
            ];
            await writeDb(db);
        }

        res.json({ success: true, departments: db.departments });
    } catch (err) {
        res.status(500).json({ success: false, departments: [] });
    }
});

app.post('/api/departments/add', async (req, res) => {
    try {
        const { name, lead, staff, budget } = req.body;
        const db = await readDb();
        if (!db.departments) db.departments = [];

        const icons = ["fa-layer-group", "fa-network-wired", "fa-atom", "fa-puzzle-piece", "fa-briefcase"];
        const colors = ["bg-sky-50 text-sky-600", "bg-teal-50 text-teal-600", "bg-violet-50 text-violet-600", "bg-emerald-50 text-emerald-600"];

        const newDept = {
            id: db.departments.length > 0 ? Math.max(...db.departments.map(d => d.id)) + 1 : 1,
            name,
            lead,
            staff: parseInt(staff) || 0,
            budget: budget.startsWith('₹') ? budget : '₹' + budget,
            icon: icons[Math.floor(Math.random() * icons.length)],
            color: colors[Math.floor(Math.random() * colors.length)],
            members: [
                { name: lead, email: `${lead.toLowerCase().replace(/\s+/g, '')}@clickormedia.co.in`, role: "Department Lead" }
            ]
        };

        db.departments.push(newDept);
        await writeDb(db);
        res.json({ success: true, message: 'Department created successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/departments/delete', async (req, res) => {
    try {
        const { id } = req.body;
        const db = await readDb();
        if (!db.departments) db.departments = [];

        db.departments = db.departments.filter(d => d.id != id);
        await writeDb(db);
        res.json({ success: true, message: 'Department removed successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/hr/departments', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'departments.html'));
});

// --- SETTINGS PERSISTENCE API ---
app.get('/api/settings', async (req, res) => {
    try {
        const db = await readDb();
        if (!db.settings) {
            db.settings = {
                companyName: "CLICKORMEDIA PRIVATE LIMITED",
                cin: "U72900DL2024PTC123456",
                hrEmail: "hr@clickormedia.co.in",
                location: "Sanat Nagar, Jammu & Kashmir, India",
                paidLeaves: 12,
                casualLeaves: 0,
                sickLeaves: 0,
                pfContribution: "12% of Basic Salary",
                cutoffDate: "7th of every month",
                shiftStartTime: "10:00 AM",
                shiftEndTime: "06:00 PM",
                gracePeriod: "5"
            };
            await writeDb(db);
        }
        res.json({ success: true, settings: db.settings });
    } catch (err) {
        res.status(500).json({ success: false, settings: {} });
    }
});

app.post('/api/settings/save', async (req, res) => {
    try {
        const { companyName, cin, hrEmail, location, paidLeaves, casualLeaves, sickLeaves, pfContribution, cutoffDate } = req.body;
        const db = await readDb();
       
        if (!db.settings) db.settings = {};

        db.settings.companyName = companyName || db.settings.companyName;
        db.settings.cin = cin || db.settings.cin;
        db.settings.hrEmail = hrEmail || db.settings.hrEmail;
        db.settings.location = location || db.settings.location;
        db.settings.paidLeaves = parseInt(paidLeaves) || 12;
        db.settings.casualLeaves = parseInt(casualLeaves) || 0;
        db.settings.sickLeaves = parseInt(sickLeaves) || 0;
        db.settings.pfContribution = pfContribution || db.settings.pfContribution;
        db.settings.cutoffDate = cutoffDate || "7th of every month";

        await writeDb(db);
        res.json({ success: true, message: 'Settings saved successfully!' });
    } catch (err) {
        console.error('Error saving settings:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/hr/settings', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'settings.html'));
});

// --- EMPLOYEE PORTAL API ---

app.get('/api/employee/stats', async (req, res) => {
    try {
        const db = await readDb();

       const sessionUser = req.session.user;

if (!sessionUser || !sessionUser.email) {
    return res.status(401).json({
        success: false,
        message: 'Please log in again.'
    });
}



if (!Array.isArray(db.users)) db.users = [];
if (!Array.isArray(db.payroll)) db.payroll = [];

const sessionEmail = sessionUser.email.trim().toLowerCase();

const dbUser = db.users.find(user =>
    user.email &&
    user.email.trim().toLowerCase() === sessionEmail &&
    user.role !== 'former'
);

if (!dbUser) {
    return res.status(403).json({
        success: false,
        message: 'Employee account not found or inactive.'
    });
}

const empName = dbUser.name;

const record = db.payroll.find(payroll =>
    payroll.email &&
    payroll.email.trim().toLowerCase() === sessionEmail
) || {
    name: dbUser.name,
    email: dbUser.email,
    dept: dbUser.department || dbUser.dept || '',
    baseNum: 0,
    leaveLogs: []
};
        // Use the current calendar month and shared HR leave calculation.
        const currentDate = new Date();
        const year = currentDate.getFullYear();
        const month = currentDate.getMonth() + 1;

        const allLeaves = Array.isArray(db.leaves)
            ? db.leaves
            : [];

        const leave = calculateMonthlyLeave(
            record,
            allLeaves,
            year,
            month
        );

        const baseSalary = Number(record.baseNum) || 0;
        const perDaySalary = baseSalary / 30;

        // Unpaid leave may be fractional, e.g. 0.5 for a half-day.
        const unpaidLeaves = Number(leave.unpaid) || 0;

        const totalDeductions = Math.round(
            unpaidLeaves * perDaySalary
        );

        const netPayout = Math.max(
            0,
            baseSalary - totalDeductions
        );

        res.json({
            success: true,
            employee: {
               name: dbUser.name,
email: dbUser.email,
dept: dbUser.department || dbUser.dept ||
    record.dept || "Software Engineering",
designation: dbUser.designation || "Employee",

                // Values come from the shared leave calculation.
                leaveBalance: leave.balance,
                earnedLeaves: leave.earned,
                leavesUsedThisMonth: leave.used,
                paidLeavesUsed: leave.paidUsed,
                unpaidLeaves: unpaidLeaves,
                extraLeaves: unpaidLeaves,
                unpaidHalfDays: leave.unpaidHalfDays,

                attendancePercentage: "96.5%",
                lastPayout: "₹" +
                    Math.round(netPayout).toLocaleString('en-IN'),

                recentLeaves: Array.isArray(record.leaveLogs)
                    ? record.leaveLogs
                    : []
            }
        });
    } catch (err) {
        console.error('Error in employee stats:', err);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});
app.get('/employee/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'emp_index.html'));
});

app.get('/employee/leaves', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'emp_leaves.html'));
});

app.get('/employee/attendance', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'emp_attendance.html'));
});

// --- API: Employee Punch-In / Punch-Out Sync with HR Portal ---

app.post('/api/employee/punch', async (req, res) => {
    try {
        // Always identify the employee from the server session.
        if (!req.session.user || !req.session.user.email) {
            return res.status(401).json({
                success: false,
                message: 'Please log in again.'
            });
        }

        const action = String(req.body.action || '').toUpperCase();

        if (!['IN', 'OUT'].includes(action)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid punch action.'
            });
        }

        const db = await readDb();
        if (!Array.isArray(db.attendance)) db.attendance = [];
        if (!Array.isArray(db.users)) db.users = [];

        const email = req.session.user.email.trim().toLowerCase();

        const dbUser = db.users.find(u =>
            u.email &&
            u.email.trim().toLowerCase() === email
        );

        if (!dbUser || dbUser.role === 'former') {
            return res.status(403).json({
                success: false,
                message: 'Employee account not found or inactive.'
            });
        }

        const empName = dbUser.name;
        const empEmail = dbUser.email;
        const empDept = dbUser.department || 'Engineering';
        const empRole = dbUser.designation || 'Staff';
        const empAvatar = dbUser.avatar || '';

        // Use local calendar date, not UTC date, for the employee's workday.
        const now = new Date();
        const todayDate = [
            now.getFullYear(),
            String(now.getMonth() + 1).padStart(2, '0'),
            String(now.getDate()).padStart(2, '0')
        ].join('-');

        const existingLog = db.attendance.find(log =>
            log.email &&
            log.email.trim().toLowerCase() === empEmail.toLowerCase() &&
            log.date === todayDate
        );

        if (action === 'IN') {
            // Never overwrite the original punch-in time for this day.
            if (existingLog) {
                return res.status(409).json({
                    success: false,
                    message: 'A punch-in record already exists for today.',
                    attendance: existingLog
                });
            }

            db.attendance.unshift({
                name: empName,
                email: empEmail,
                dept: empDept,
                role: empRole,
                date: todayDate,
                checkInTime: req.body.time || now.toLocaleTimeString(
                    'en-IN',
                    { hour: '2-digit', minute: '2-digit', hour12: true }
                ),
                checkInLoc: req.body.location || 'Office Headquarters',
                checkOutTime: '--:--',
                checkOutLoc: 'Pending',
                status: 'On Time',
                avatar: empAvatar
            });
        } else {
            // Punch-out must update an existing open shift only.
            if (!existingLog) {
                return res.status(409).json({
                    success: false,
                    message: 'No punch-in record exists for today.'
                });
            }

            if (
                existingLog.checkOutTime &&
                !['--:--', 'Pending'].includes(existingLog.checkOutTime)
            ) {
                return res.status(409).json({
                    success: false,
                    message: 'You have already punched out today.'
                });
            }

            existingLog.checkOutTime = req.body.time || now.toLocaleTimeString(
                'en-IN',
                { hour: '2-digit', minute: '2-digit', hour12: true }
            );
            existingLog.checkOutLoc =
                req.body.location || 'Office Headquarters';
        }

        await writeDb(db);

        return res.json({
            success: true,
            action,
            message: `Punch ${action} saved successfully.`,
            attendance: db.attendance.find(log =>
                log.email &&
                log.email.trim().toLowerCase() === empEmail.toLowerCase() &&
                log.date === todayDate
            )
        });
    } catch (err) {
        console.error('Error recording punch:', err);
        return res.status(500).json({
            success: false,
            message: 'Server error during punch recording.'
        });
    }
});
// --- API: Get Today's Punch Status for Employee ---
app.get('/api/employee/punch-status', async (req, res) => {
    try {
        if (!req.session.user || !req.session.user.email) {
            return res.status(401).json({
                success: false,
                isPunchedIn: false,
                message: 'Please log in again.'
            });
        }

        const email = req.session.user.email.trim().toLowerCase();
        const db = await readDb();
        const now = new Date();

        const todayDate = [
            now.getFullYear(),
            String(now.getMonth() + 1).padStart(2, '0'),
            String(now.getDate()).padStart(2, '0')
        ].join('-');

        const attendance = Array.isArray(db.attendance) ? db.attendance : [];

        const todayLog = attendance.find(log =>
            log.email &&
            log.email.trim().toLowerCase() === email &&
            log.date === todayDate
        );

        const isOpen = todayLog &&
            (!todayLog.checkOutTime ||
             ['--:--', 'Pending'].includes(todayLog.checkOutTime));

        return res.json({
            success: true,
            isPunchedIn: Boolean(isOpen),
            time: isOpen ? todayLog.checkInTime : null,
            location: isOpen ? todayLog.checkInLoc : null
        });
    } catch (err) {
        console.error('Error fetching punch status:', err);
        return res.status(500).json({
            success: false,
            isPunchedIn: false
        });
    }
});
// Employee Specific Payroll API Route
app.get('/api/employee/payroll', async (req, res) => {
    try {
        const db = await readDb();
        if (!db.payroll) db.payroll = [];

        let currentUserName = req.query.name || (req.session.user ? req.session.user.name : "Pranchal Rajpal");
       
        let userPayroll = db.payroll.find(p => p.name && p.name.toLowerCase() === currentUserName.toLowerCase());
       
        if (!userPayroll) {
            userPayroll = db.payroll.find(p => p.name && p.name.toLowerCase().includes("pranchal")) || db.payroll[1] || db.payroll[0];
        }

       const payrollRecord = userPayroll;

const now = new Date();
const year = now.getFullYear();
const month = now.getMonth() + 1;

const leave = calculateMonthlyLeave(
    payrollRecord,
    db.leaves || [],
    year,
    month
);

const payrollObj = {
    ...payrollRecord,
    earnedLeaves: leave.earned,
    leavesUsedThisMonth: leave.used,
    paidLeavesUsed: leave.paidUsed,
    unpaidLeaves: leave.unpaid,
    unpaidHalfDays: leave.unpaidHalfDays,
    calculatedLeaveBalance: leave.balance,
    extraLeaves: leave.unpaid
};  

res.json({ success: true, payroll: payrollObj });
    } catch (err) {
        console.error('Error fetching employee payroll:', err);
        res.status(500).json({ success: false, payroll: null });
    }
});

app.get('/employee/payroll', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'emp_payroll.html'));
});

app.get('/employee/holidaycalendar', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'emp_holidaycalendar.html'));
});

app.get('/api/current-user', async (req, res) => {
    try {
        if (!req.session.user || !req.session.user.email) {
            return res.status(401).json({
                success: false,
                message: 'Not logged in'
            });
        }

        const db = await readDb();
        const email = req.session.user.email.trim().toLowerCase();

        const user = (db.users || []).find(
            u => u.email &&
                 u.email.trim().toLowerCase() === email
        );

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Employee not found'
            });
        }

        return res.json({
            success: true,
            user: {
                name: user.name,
                email: user.email,
                role: user.role,
                department: user.department || user.dept || ''
            }
        });
    } catch (err) {
        console.error('Current-user error:', err);
        return res.status(500).json({
            success: false,
            message: 'Unable to load current user'
        });
    }
});
app.get('/employee/settings', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'emp_settings.html'));
});

// API: Edit Employee Details & Department
app.put('/api/employees/edit/:id', async (req, res) => {
    try {
        const empId = req.params.id;
        const { name, email, designation, department } = req.body;
        const db = await readDb();

        let oldEmployeeName = "";

        if (db.users) {
            let user = db.users.find(u => u._id === empId || (u.email && u.email.toLowerCase() === (email || "").toLowerCase()));
            if (user) {
                oldEmployeeName = user.name;
                user.name = name || user.name;
                user.email = email || user.email;
                user.designation = designation || user.designation;
                user.department = department || user.department;
            }
        }

        if (db.departments && oldEmployeeName) {
            db.departments.forEach(dept => {
                if (dept.members) {
                    dept.members.forEach(member => {
                        if (member.name.toLowerCase() === oldEmployeeName.toLowerCase()) {
                            member.department = department || member.department;
                            member.designation = designation || member.designation;
                        }
                    });
                }
            });
        }

        if (db.payroll && oldEmployeeName) {
            let payrollRec = db.payroll.find(p => p.name && p.name.toLowerCase() === oldEmployeeName.toLowerCase());
            if (payrollRec) {
                payrollRec.dept = department || payrollRec.dept;
            }
        }

        await writeDb(db);
        console.log(`--- FULLY SYNCED & UPDATED: ${oldEmployeeName} -> Dept: ${department} ---`);
        return res.json({ success: true, message: 'Employee details and department updated successfully across all modules!' });

    } catch (err) {
        console.error('Error updating employee:', err);
        res.status(500).json({ success: false, message: 'Server error while updating employee' });
    }
});

// Start listening on port 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
