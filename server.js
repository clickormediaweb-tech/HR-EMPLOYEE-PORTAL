
const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');    
const session = require('express-session'); // <-- Added for session management

const app = express();

const mongoose = require('mongoose');
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://clickormediaweb_db_user:Clickormedia123@cluster0.uqgeway.mongodb.net/hr_portal?retryWrites=true&w=majority&appName=Cluster0";
mongoose.connect(MONGO_URI)
    .then(() => console.log("--- CONNECTED TO MONGODB ATLAS SUCCESSFULLY ---"))
    .catch(err => console.error("MongoDB connection error:", err));

// --- MONGODB SAFE STORE SCHEMA (Without Index Crash) ---
const storeSchema = new mongoose.Schema({
    key: { type: String, default: "main_singleton_store" },
    data: { type: Object, default: {} }
}, { strict: false });

const Store = mongoose.models.Store || mongoose.model('Store', storeSchema);
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
async function readDb() {
    try {
        let record = await Store.findOne({ key: "main_singleton_store" });
        if (!record) {
            record = await Store.findOne({}); // Fallback to any existing record if key isn't set yet
        }
        if (record && record.data) {
            return record.data;
        }
        let defaultData = { users: [], attendance: [], leaves: [], myLeaves: [], holidays: [], payroll: [], departments: [], settings: {} };
        await Store.create({ key: "main_singleton_store", data: defaultData });
        return defaultData;
    } catch (err) {
        console.error("Error reading from MongoDB:", err);
        return { users: [], attendance: [], leaves: [], myLeaves: [], holidays: [], payroll: [], departments: [], settings: {} };
    }
}

// Atomic Safe Writer with Safety Lock
async function writeDb(newData) {
    try {
        let record = await Store.findOne({ key: "main_singleton_store" });
        if (!record) {
            record = await Store.findOne({});
        }
       
        if (record && record.data) {
            // Attendance Protection
            if (record.data.attendance && Array.isArray(record.data.attendance) && record.data.attendance.length > 0) {
                if (!newData.attendance || newData.attendance.length < record.data.attendance.length) {
                    console.log("🛡️ SAFETY LOCK: Preserving older attendance records.");
                    newData.attendance = record.data.attendance;
                }
            }
            // Users Protection
            if (record.data.users && Array.isArray(record.data.users) && record.data.users.length > 0) {
                if (!newData.users || newData.users.length < record.data.users.length) {
                    newData.users = record.data.users;
                }
            }
            // Payroll Protection
            if (record.data.payroll && Array.isArray(record.data.payroll) && record.data.payroll.length > 0) {
                if (!newData.payroll || newData.payroll.length < record.data.payroll.length) {
                    newData.payroll = record.data.payroll;
                }
            }
        }

        if (record) {
            record.key = "main_singleton_store";
            record.set('data', newData);
            record.markModified('data');
            await record.save();
        } else {
            await Store.create({ key: "main_singleton_store", data: newData });
        }
       
        console.log("--- DATABASE SAFELY PERSISTED & PROTECTED ---");
    } catch (err) {
        console.error("Error writing to MongoDB:", err);
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
});// 2. Strict Login Verification Route with Role-Based Redirection
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

console.log("[LOGIN DIAGNOSTIC]", {
    usersArrayExists: Array.isArray(db.users),
    usersCount: Array.isArray(db.users) ? db.users.length : 0,
    emailFound: Boolean(user),
    passwordMatches: Boolean(user && user.password === password),
    role: user ? user.role : null
});

if (user && user.password === password) {
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
        const db = await readDb();
        if (!db.attendance) db.attendance = [];

        let currentUserName = req.query.name || (req.session.user ? req.session.user.name : "Pranchal Rajpal");
        let currentUserEmail = req.query.email || (req.session.user ? req.session.user.email : "pranchal@clickormedia.co.in");

        // Is user ke saare attendance logs filter karke bhejein
        let userLogs = db.attendance.filter(log =>
            (log.name && log.name.toLowerCase() === currentUserName.toLowerCase()) ||
            (log.email && log.email.toLowerCase() === currentUserEmail.toLowerCase())
        );

        res.json({ success: true, attendance: userLogs });
    } catch (err) {
        console.error('Error fetching employee attendance:', err);
        res.status(500).json({ success: false, attendance: [] });
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
        const db = await readDb();
        if (!db.leaves) {
            db.leaves = [];
            await writeDb(db);
        }
        if (!db.myLeaves) {
            db.myLeaves = [];
        }
        res.json({ success: true, leaves: db.leaves, myLeaves: db.myLeaves });
    } catch (err) {
        res.status(500).json({ success: false, leaves: [], myLeaves: [] });
    }
});

app.get('/api/employee/leaves', async (req, res) => {
    try {
        const db = await readDb();
        if (!db.leaves) db.leaves = [];
       
        let currentUserName = req.query.name || "Pranchal Rajpal";
       
        let userLeaves = db.leaves.filter(l =>
            l.name && l.name.toLowerCase() === currentUserName.toLowerCase()
        );

        res.json({ success: true, myLeaves: userLeaves });
    } catch (err) {
        res.status(500).json({ success: false, myLeaves: [] });
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

  return {
    ...rec,
    earnedLeaves: leave.earned,
    leavesUsedThisMonth: leave.used,
    paidLeavesUsed: leave.paidUsed,
    unpaidLeaves: leave.unpaid,
    unpaidHalfDays: leave.unpaidHalfDays,
    calculatedLeaveBalance: leave.balance
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

        function findRecords(records, source) {
            return (Array.isArray(records) ? records : [])
                .filter(leave =>
                    String(leave.name || "")
                        .trim()
                        .toLowerCase() === employeeName
                )
                .map(leave => ({
                    source,
                    id: leave.id,
                    name: leave.name,
                    type: leave.type,
                    duration: leave.duration,
                    dayType: leave.dayType,
                    startDate: leave.startDate,
                    endDate: leave.endDate,
                    status: leave.status
                }));
        }

        const leaves = [
            ...findRecords(db.leaves, "leaves"),
            ...findRecords(db.myLeaves, "myLeaves")
        ];

        res.json({
            success: true,
            employee: employeeName,
            leavesCount: Array.isArray(db.leaves) ? db.leaves.length : 0,
            myLeavesCount: Array.isArray(db.myLeaves) ? db.myLeaves.length : 0,
            matchingRecords: leaves.length,
            leaves
        });
    } catch (err) {
        console.error("Debug employee leaves error:", err);
        res.status(500).json({
            success: false,
            message: "Could not read leave records"
        });
    }
});
app.post('/api/payroll/update-status', async (req, res) => {
    try {
        const { id, status } = req.body;
        const db = await readDb();
        if (!db.payroll) db.payroll = [];

        if (id === 'all') {
            db.payroll.forEach(r => r.status = status);
        } else {
            let rec = db.payroll.find(r => r.id == id);
            if (rec) rec.status = status;
        }

        await writeDb(db);
        res.json({ success: true, message: 'Payroll status updated successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
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

        const empName =
            (req.session.user && req.session.user.name)
                ? req.session.user.name
                : (req.query.name || "Pranchal Rajpal");

        if (!Array.isArray(db.payroll)) {
            db.payroll = [];
        }

        const record =
            db.payroll.find(p =>
                p.name &&
                p.name.toLowerCase() === empName.toLowerCase()
            ) ||
            db.payroll[0] ||
            {
                name: empName,
                baseNum: 25000,
                leaveBalance: 0,
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
                name: record.name || empName,
                email: record.email ||
                    `${empName.toLowerCase().replace(/\s+/g, '')}@clickormedia.co.in`,
                dept: record.dept || "Software Engineering",

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
        const { name, email, action, time, location } = req.body;
        const db = await readDb();
        if (!db.attendance) db.attendance = [];
        if (!db.users) db.users = [];

        // Database se employee ka real data find karein
        let dbUser = db.users.find(u => u.email && email && u.email.toLowerCase() === email.toLowerCase()) ||
                     db.users.find(u => u.name && name && u.name.toLowerCase() === name.toLowerCase());

        let empName = dbUser ? dbUser.name : (name || "Employee");
        let empEmail = dbUser ? dbUser.email : (email || "employee@clickormedia.co.in");
        let empDept = dbUser ? dbUser.department : "Engineering";
        let empRole = dbUser ? dbUser.designation : "Staff";
        let empAvatar = dbUser ? dbUser.avatar : "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&h=80&fit=crop&crop=faces";

        const todayDate = new Date().toISOString().split('T')[0];
        let existingLog = db.attendance.find(log =>
            log.email && log.email.toLowerCase() === empEmail.toLowerCase() && log.date === todayDate
        );

        if (action === 'IN') {
            if (!existingLog) {
                db.attendance.unshift({
                    name: empName,
                    email: empEmail,
                    dept: empDept,
                    role: empRole,
                    date: todayDate,
                    checkInTime: time,
                    checkInLoc: location,
                    checkOutTime: "--:--",
                    checkOutLoc: "Pending",
                    status: "On Time",
                    avatar: empAvatar
                });
            } else {
                existingLog.checkInTime = time;
                existingLog.checkInLoc = location;
                existingLog.role = empRole;
                existingLog.dept = empDept;
            }
        } else if (action === 'OUT') {
            if (existingLog) {
                existingLog.checkOutTime = time;
                existingLog.checkOutLoc = location;
            } else {
                db.attendance.unshift({
                    name: empName,
                    email: empEmail,
                    dept: empDept,
                    role: empRole,
                    date: todayDate,
                    checkInTime: "09:00 AM",
                    checkInLoc: "Office HQ",
                    checkOutTime: time,
                    checkOutLoc: location,
                    status: "On Time",
                    avatar: empAvatar
                });
            }
        }

        await writeDb(db);
        console.log(`--- PUNCH ${action} SAVED FROM DB FOR ${empName} (${empRole}) ---`);
        res.json({ success: true, message: `Punch ${action} recorded using database profile successfully!` });
    } catch (err) {
        console.error('Error recording punch:', err);
        res.status(500).json({ success: false, message: 'Server error during punch recording' });
    }
});// --- API: Get Today's Punch Status for Employee ---
app.get('/api/employee/punch-status', async (req, res) => {
    try {
        const email = req.query.email || (req.session.user ? req.session.user.email : "");
        const db = await readDb();
        const todayDate = new Date().toISOString().split('T')[0];

        if (!db.attendance) db.attendance = [];
       
        let todayLog = db.attendance.find(log =>
            log.email.toLowerCase() === email.toLowerCase() &&
            log.date === todayDate &&
            (!log.checkOutTime || log.checkOutTime === "--:--" || log.checkOutTime === "Pending")
        );

        if (todayLog) {
            res.json({ success: true, isPunchedIn: true, time: todayLog.checkInTime, location: todayLog.checkInLoc });
        } else {
            res.json({ success: true, isPunchedIn: false });
        }
    } catch (err) {
        res.status(500).json({ success: false, isPunchedIn: false });
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
        const dbData = await readDb();
        const users = dbData.users || [];
       
        let activeName = (req.session.user && req.session.user.name) ? req.session.user.name : (req.query.name || "Pranchal Rajpal");
        let activeEmail = (req.session.user && req.session.user.email) ? req.session.user.email : "";

        let currentUser = users.find(u =>
            (activeEmail && u.email && u.email.toLowerCase() === activeEmail.toLowerCase()) ||
            (u.name && u.name.toLowerCase() === activeName.toLowerCase())
        ) || users[0];

        res.json({
            success: true,
            _id: currentUser._id || "",
            name: currentUser.name || "Employee",
            email: currentUser.email || "",
            role: currentUser.role || "employee",
            department: currentUser.department || "Engineering",
            designation: currentUser.designation || "Staff",
            avatar: currentUser.avatar || "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&h=80&fit=crop&crop=faces"
        });
    } catch (err) {
        console.error("Error fetching current user:", err);
        res.status(500).json({ success: false, error: "Failed to fetch user profile" });
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
