const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const session = require('express-session'); // <-- Added for session management

const app = express();

// Middleware
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

// Helper functions to read/write database.json safely
const dbFilePath = path.join(__dirname, 'database.json');

function readDb() {
    if (!fs.existsSync(dbFilePath)) {
        return {
            users: [],
            attendance: [],
            leaves: [],
            myLeaves: [],
            holidays: [],
            payroll: [],
            departments: [],
            settings: { shiftStartTime: "09:30 AM", shiftEndTime: "06:30 PM", gracePeriod: "15" }
        };
    }
    const data = fs.readFileSync(dbFilePath, 'utf8');
    return JSON.parse(data);
}

function writeDb(data) {
    fs.writeFileSync(dbFilePath, JSON.stringify(data, null, 2), 'utf8');
}

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


// 1. Password Update Route (Directly updates user password in database.json)
// 1. Password Update Route (Dynamic & Secure for all users)
app.post('/api/employee/update-password', (req, res) => {
    try {
        const { newPassword } = req.body;
        console.log("Incoming password update request:", newPassword);

        if (!newPassword || newPassword.length < 6) {
            return res.status(400).json({ success: false, message: "Password must be at least 6 characters long." });
        }
       
        const db = readDb();
        if (!db.users) db.users = [];
       
        // Session ya logged-in user ke email se user ko find karein
        let userEmail = req.session.user ? req.session.user.email : "pranchal@clickormedia.co.in";
        let user = db.users.find(u => u.email && u.email.toLowerCase() === userEmail.toLowerCase());
       
        if (!user && db.users.length > 0) {
            user = db.users[1] || db.users[0];
        }
       
        if (user) {
            user.password = newPassword;
            writeDb(db);
            console.log(`SUCCESS: Password updated in database.json for ${user.name} to ${newPassword}`);
            return res.json({ success: true, message: "Password updated successfully" });
        } else {
            console.log("ERROR: No users found in database.json");
            return res.status(404).json({ success: false, message: "User not found in database" });
        }
    } catch (err) {
        console.error('Critical error updating password:', err);
        res.status(500).json({ success: false, message: "Server error while updating password." });
    }
});

// 2. Strict Login Verification Route with Role-Based Redirection
app.post('/api/auth/login', (req, res) => {
    try {
        const { email, password } = req.body;
        const db = readDb();
       
        const user = db.users ? db.users.find(u => u.email.toLowerCase() === (email || "").trim().toLowerCase()) : null;
       
        if (user && user.password === password) {
            req.session.user = { name: user.name, email: user.email, role: user.role };
           
            // Role ke hisab se redirection (agar role admin hai toh HR portal)
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
        res.clearCookie('connect.sid'); // Clear session cookie
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
app.get('/hr/employees', (req, res) => {
    try {
        const db = readDb();
        const employees = db.users ? db.users.filter(u => u.role === 'employee' || u.role === 'admin') : [];
        const exEmployees = db.users ? db.users.filter(u => u.role === 'former') : [];
       
        res.render('employee', { employees, exEmployees });
    } catch (err) {
        console.error('Error fetching employees page:', err);
        res.status(500).send('Server Error');
    }
});

// --- API: Get Total Employee Count for Dashboard Stats ---
app.get('/api/hr/stats', (req, res) => {
    try {
        const db = readDb();
        const activeUsers = db.users ? db.users.filter(u => u.role !== 'former') : [];
       
        res.json({
            success: true,
            totalEmployees: activeUsers.length > 0 ? activeUsers.length : 5 // Fallback count
        });
    } catch (err) {
        console.error('Error fetching HR stats:', err);
        res.status(500).json({ success: false, totalEmployees: 0 });
    }
});

// API: Get Active Employees (JSON for attendance modal dropdowns)
app.get('/api/employees/active', (req, res) => {
    try {
        const db = readDb();
        const activeEmployees = db.users ? db.users.filter(u => u.role === 'employee' || u.role === 'admin') : [];
        res.json({ success: true, employees: activeEmployees });
    } catch (err) {
        res.status(500).json({ success: false, employees: [] });
    }
});

// 5. API: Add New Employee
app.post('/api/employees/add', (req, res) => {
    try {
        const { name, email, department, designation, phone } = req.body;
        const db = readDb();
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
            avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&h=80&fit=crop&crop=faces'
        };

        db.users.push(newEmployee);
        writeDb(db);

        console.log(`--- PERMANENTLY ADDED: ${name} ---`);
        res.json({ success: true, message: 'Employee added successfully!' });
    } catch (err) {
        console.error('Error adding employee:', err);
        res.status(500).json({ success: false, message: 'Server error while adding employee' });
    }
});

// 6. API: Archive Employee (Soft Delete -> removes from Active Directory, Attendance, and Leaves)
app.delete('/api/employees/:id', (req, res) => {
    try {
        const empId = req.params.id;
        const db = readDb();

        if (db.users) {
            const user = db.users.find(u => u._id === empId || u.email === empId);
            if (user) {
                user.role = 'former';
               
                // 1. Remove from active attendance logs
                if (db.attendance) {
                    db.attendance = db.attendance.filter(log => log.email.toLowerCase() !== user.email.toLowerCase());
                }

                // 2. Remove from active leave requests
                if (db.leaves) {
                    db.leaves = db.leaves.filter(leave => leave.email && leave.email.toLowerCase() !== user.email.toLowerCase());
                }

                writeDb(db);
                console.log(`--- PERMANENTLY REMOVED & SYNCED ACROSS ALL MODULES: ${user.name} ---`);
            }
        }

        res.json({ success: true, message: 'Employee archived and synced successfully!' });
    } catch (err) {
        console.error('Error archiving employee:', err);
        res.status(500).json({ success: false, message: 'Server error while archiving employee' });
    }
});

// 7. API: Get Attendance Logs
app.get('/api/attendance', (req, res) => {
    try {
        const db = readDb();
        const activeUsers = db.users ? db.users.filter(u => u.role !== 'former') : [];
        const activeEmails = activeUsers.map(u => u.email.toLowerCase());

        if (!db.attendance) {
            db.attendance = [
                { name: "Tanya Dua", email: "tanya@clickormedia.co.in", dept: "HR & Finance", role: "HR Manager", checkInTime: "08:55 AM", checkInLoc: "Head Office (Terminal A)", checkOutTime: "06:00 PM", checkOutLoc: "Head Office (Terminal A)", status: "On Time", avatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&h=100&fit=crop&crop=faces" },
                { name: "Pranchal Rajpal", email: "pranchal@clickormedia.co.in", dept: "Engineering", role: "Software Engineer", checkInTime: "09:00 AM", checkInLoc: "Remote / WFH (GPS Verified)", checkOutTime: "06:30 PM", checkOutLoc: "Remote / WFH (GPS Verified)", status: "On Time", avatar: "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&h=80&fit=crop&crop=faces" },
                { name: "Anshdeep", email: "anshdeep@clickormedia.co.in", dept: "Engineering", role: "Frontend Developer", checkInTime: "09:10 AM", checkInLoc: "Head Office (Terminal B)", checkOutTime: "06:00 PM", checkOutLoc: "Head Office (Terminal B)", status: "On Time", avatar: "https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?w=100&h=100&fit=crop&crop=faces" },
                { name: "Sukhi", email: "sukhi@clickormedia.co.in", dept: "Operations", role: "Operations Executive", checkInTime: "09:45 AM", checkInLoc: "Branch Office (Jammu)", checkOutTime: "06:15 PM", checkOutLoc: "Branch Office (Jammu)", status: "Late", avatar: "https://images.unsplash.com/photo-1580489944761-15a19d654956?w=100&h=100&fit=crop&crop=faces" },
                { name: "Robin", email: "robin@clickormedia.co.in", dept: "Marketing", role: "Marketing Specialist", checkInTime: "09:15 AM", checkInLoc: "Head Office (Terminal A)", checkOutTime: "06:00 PM", checkOutLoc: "Head Office (Terminal A)", status: "On Time", avatar: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&h=100&fit=crop&crop=faces" }
            ];
            writeDb(db);
        }

        const filteredAttendance = db.attendance.filter(log => activeEmails.includes(log.email.toLowerCase()));
        res.json({ success: true, attendance: filteredAttendance });
    } catch (err) {
        console.error('Error fetching attendance:', err);
        res.status(500).json({ success: false, attendance: [] });
    }
});

// 8. API: Save Manual Attendance Log
app.post('/api/attendance/add', (req, res) => {
    try {
        const { name, email, dept, role, date, checkInTime, checkInLoc, checkOutTime, checkOutLoc, status, avatar } = req.body;
        const db = readDb();
        if (!db.attendance) db.attendance = [];

        const newLog = { name, email, dept, role, date: date || '2026-09-28', checkInTime, checkInLoc, checkOutTime, checkOutLoc, status, avatar };
        db.attendance.unshift(newLog);
        writeDb(db);

        console.log(`--- ATTENDANCE LOG RECORDED FOR ${name} ON ${date} ---`);
        res.json({ success: true, message: 'Attendance recorded successfully!' });
    } catch (err) {
        console.error('Error saving attendance:', err);
        res.status(500).json({ success: false, message: 'Server error while saving attendance' });
    }
});

// 9. API: Get Settings / Office Timings
app.get('/api/settings', (req, res) => {
    try {
        const db = readDb();
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
            writeDb(db);
        }
        res.json({ success: true, settings: db.settings });
    } catch (err) {
        res.status(500).json({ success: false, settings: { shiftStartTime: "09:30 AM", shiftEndTime: "06:30 PM", gracePeriod: "15" } });
    }
});

// 10. API: Save Office Timings Permanently
app.post('/api/settings/update', (req, res) => {
    try {
        const { shiftStartTime, shiftEndTime, gracePeriod } = req.body;
        const db = readDb();
        
        // Ensure karein ki db.settings object exist karta hai
        if (!db.settings) db.settings = {};
        
        // Sirf settings update honi chahiye, baki data ko touch nahi karna hai
        db.settings.shiftStartTime = shiftStartTime || "09:30 AM";
        db.settings.shiftEndTime = shiftEndTime || "06:30 PM";
        db.settings.gracePeriod = gracePeriod || "15";

        writeDb(db); // Yeh sirf database.json mein save karega, attendance delete nahi hogi
        
        res.json({ success: true, message: 'Settings saved permanently!' });
    } catch (err) {
        console.error('Error saving settings:', err);
        res.status(500).json({ success: false, message: 'Server error while saving settings' });
    }
});

// --- LEAVE MANAGEMENT APIS ---

app.get('/api/leaves', (req, res) => {
    try {
        const db = readDb();
        if (!db.leaves || db.leaves.length === 0) {
            db.leaves = [
                { id: 1, name: "Pranchal Rajpal", email: "pranchal@clickormedia.co.in", type: "Annual Leave", duration: "Oct 02 - Oct 05 (4 Days)", reason: "Personal work & family trip", status: "PENDING", updatedAt: "12:00 PM", avatar: "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&h=80&fit=crop&crop=faces" },
                { id: 2, name: "Anshdeep", email: "anshdeep@clickormedia.co.in", type: "Sick Leave", duration: "Sep 28 (1 Day)", reason: "Viral Fever", status: "APPROVED", updatedAt: "12:00 PM", avatar: "https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?w=80&h=80&fit=crop&crop=faces" },
                { id: 3, name: "Sukhi", email: "sukhi@clickormedia.co.in", type: "Casual Leave", duration: "Oct 10 (1 Day)", reason: "Personal Errands", status: "PENDING", updatedAt: "12:00 PM", avatar: "https://images.unsplash.com/photo-1580489944761-15a19d654956?w=80&h=80&fit=crop&crop=faces" },
                { id: 4, name: "Robin", email: "robin@clickormedia.co.in", type: "Annual Leave", duration: "Nov 12 - Nov 15 (4 Days)", reason: "Out of Station", status: "REJECTED", updatedAt: "12:00 PM", avatar: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=80&h=80&fit=crop&crop=faces" },
                { id: 5, name: "Tanya Dua", email: "tanya@clickormedia.co.in", type: "Sick Leave", duration: "Sep 29 (1 Day)", reason: "Medical Appointment", status: "APPROVED", updatedAt: "12:00 PM", avatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&h=100&fit=crop&crop=faces" }
            ];
            writeDb(db);
        }
        if (!db.myLeaves) {
            db.myLeaves = [];
        }
        res.json({ success: true, leaves: db.leaves, myLeaves: db.myLeaves });
    } catch (err) {
        res.status(500).json({ success: false, leaves: [], myLeaves: [] });
    }
});

app.get('/api/employee/leaves', (req, res) => {
    try {
        const db = readDb();
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

app.get('/api/hr/leaves', (req, res) => {
    try {
        const db = readDb();
        res.json({ success: true, leaves: db.leaves || [] });
    } catch (err) {
        res.status(500).json({ success: false, leaves: [] });
    }
});

app.post('/api/leaves/update', (req, res) => {
    try {
        const { id, status } = req.body;
        const db = readDb();
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

        writeDb(db);
        res.json({ success: true, message: 'Status updated successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/leaves/apply', async (req, res) => {
    try {
        const { type, duration, reason, name } = req.body;
        const db = readDb();
        if (!db.leaves) db.leaves = [];
        if (!db.myLeaves) db.myLeaves = [];

        let applicantName = name || "Pranchal Rajpal";
        let applicantEmail = "pranchal@clickormedia.co.in";
        let currentTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        let newSub = {
            id: Date.now(),
            name: applicantName,
            email: applicantEmail,
            type,
            duration,
            reason,
            status: "PENDING",
            updatedAt: currentTime,
            avatar: "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&h=80&fit=crop&crop=faces"
        };

        db.leaves.unshift(newSub);
        db.myLeaves.unshift(newSub);
        writeDb(db);

        res.json({ success: true, message: 'Leave application submitted successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// --- HOLIDAY APIS ---
app.get('/api/holidays', (req, res) => {
    try {
        const db = readDb();
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
            writeDb(db);
        }
        res.json({ success: true, holidays: db.holidays });
    } catch (err) {
        res.status(500).json({ success: false, holidays: [] });
    }
});

app.post('/api/holidays/add', (req, res) => {
    try {
        const { date, day, name, category } = req.body;
        const db = readDb();
        if (!db.holidays) db.holidays = [];

        db.holidays.push({ date, day, name, category });
        db.holidays.sort((a, b) => new Date(a.date) - new Date(b.date));
        writeDb(db);

        res.json({ success: true, message: 'Holiday added successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.delete('/api/holidays/:index', (req, res) => {
    try {
        const index = parseInt(req.params.index);
        const db = readDb();
        if (db.holidays && db.holidays[index]) {
            db.holidays.splice(index, 1);
            writeDb(db);
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
app.get('/api/analytics', (req, res) => {
    try {
        const db = readDb();
        const activeUsers = db.users ? db.users.filter(u => u.role === 'employee' || u.role === 'admin') : [];
       
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

// --- PAYROLL PERSISTENCE API ---
app.get('/api/payroll', (req, res) => {
    try {
        const db = readDb();
        if (!db.payroll || db.payroll.length === 0) {
            db.payroll = [
                { id: 1, name: "Tanya Dua", email: "tanya@clickormedia.co.in", dept: "HR & Finance", baseNum: 85000, leaveBalance: 5, halfDays: 0, status: "PAID", leaveLogs: [{ date: "Sep 29, 2026", day: "Tuesday", type: "Paid Leave", reason: "Medical Appointment" }], avatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&h=100&fit=crop&crop=faces" },
                { id: 2, name: "Pranchal Rajpal", email: "pranchal@clickormedia.co.in", dept: "Engineering", baseNum: 110000, leaveBalance: 4, halfDays: 0, status: "PAID", leaveLogs: [], avatar: "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&h=80&fit=crop&crop=faces" },
                { id: 3, name: "Anshdeep", email: "anshdeep@clickormedia.co.in", dept: "Engineering", baseNum: 95000, leaveBalance: 6, halfDays: 0, status: "PAID", leaveLogs: [{ date: "Sep 28, 2026", day: "Monday", type: "Paid Leave", reason: "Viral Fever" }], avatar: "https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?w=100&h=100&fit=crop&crop=faces" },
                { id: 4, name: "Sukhi", email: "sukhi@clickormedia.co.in", dept: "Operations", baseNum: 70000, leaveBalance: 3, halfDays: 1, status: "PENDING", leaveLogs: [{ date: "Sep 18, 2026", day: "Friday", type: "Paid Leave", reason: "Personal Work" }], avatar: "https://images.unsplash.com/photo-1580489944761-15a19d654956?w=100&h=100&fit=crop&crop=faces" },
                { id: 5, name: "Robin", email: "robin@clickormedia.co.in", dept: "Marketing", baseNum: 80000, leaveBalance: 5, halfDays: 0, status: "PAID", leaveLogs: [], avatar: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&h=100&fit=crop&crop=faces" }
            ];
            writeDb(db);
        }

        const activeUsers = db.users ? db.users.filter(u => u.role !== 'former') : [];
        const activeEmails = activeUsers.map(u => u.email.toLowerCase());

        const filteredPayroll = db.payroll.filter(rec => activeEmails.includes(rec.email.toLowerCase()));
       
        res.json({ success: true, payroll: filteredPayroll });
    } catch (err) {
        res.status(500).json({ success: false, payroll: [] });
    }
});

app.post('/api/payroll/update-status', (req, res) => {
    try {
        const { id, status } = req.body;
        const db = readDb();
        if (!db.payroll) db.payroll = [];

        if (id === 'all') {
            db.payroll.forEach(r => r.status = status);
        } else {
            let rec = db.payroll.find(r => r.id == id);
            if (rec) rec.status = status;
        }

        writeDb(db);
        res.json({ success: true, message: 'Payroll status updated successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/payroll/update-attendance', (req, res) => {
    try {
        const { id, leaveBalance, halfDays } = req.body;
        const db = readDb();
        if (!db.payroll) db.payroll = [];

        let rec = db.payroll.find(r => r.id == id);
        if (rec) {
            rec.leaveBalance = parseFloat(leaveBalance);
            rec.halfDays = parseFloat(halfDays);
            writeDb(db);
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

app.post('/api/payroll/update-salary', (req, res) => {
    try {
        const { id, baseNum } = req.body;
        const db = readDb();
        if (!db.payroll) db.payroll = [];

        let rec = db.payroll.find(r => r.id == id);
        if (rec) {
            rec.baseNum = parseFloat(baseNum);
            writeDb(db);
            res.json({ success: true, message: 'Base salary updated successfully!' });
        } else {
            res.status(404).json({ success: false, message: 'Payroll record not found' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/payroll/add-leave-log', (req, res) => {
    try {
        const { id, type, reason, date, day, isHalfDay } = req.body;
        const db = readDb();
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

            writeDb(db);
            res.json({ success: true, message: 'Leave log and attendance penalty updated successfully!' });
        } else {
            res.status(404).json({ success: false, message: 'Record not found' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/payroll/delete-leave-log', (req, res) => {
    try {
        const { id, logIndex } = req.body;
        const db = readDb();
        if (!db.payroll) db.payroll = [];

        let rec = db.payroll.find(r => r.id == id);
        if (rec && rec.leaveLogs) {
            let removedLog = rec.leaveLogs.splice(logIndex, 1)[0];
           
            if (removedLog && removedLog.type.includes('Half-Day') && rec.halfDays > 0) {
                rec.halfDays = Math.max(0, rec.halfDays - 0.5);
            }

            writeDb(db);
            res.json({ success: true, message: 'Leave log removed successfully!' });
        } else {
            res.status(404).json({ success: false, message: 'Record or log not found' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// --- DEPARTMENTS PERSISTENCE API ---
app.get('/api/departments', (req, res) => {
    try {
        const db = readDb();
       
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
                        { name: "Anshdeep", email: "anshdeep@clickormedia.co.in", role: "Frontend Developer" },
                        { name: "Sukhi", email: "sukhi@clickormedia.co.in", role: "Operations Specialist" }
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
                        { name: "Pranchal Rajpal", email: "pranchal@clickormedia.co.in", role: "Software Engineer" }
                    ]
                }
            ];
            writeDb(db);
        }

        res.json({ success: true, departments: db.departments });
    } catch (err) {
        res.status(500).json({ success: false, departments: [] });
    }
});

app.post('/api/departments/add', (req, res) => {
    try {
        const { name, lead, staff, budget } = req.body;
        const db = readDb();
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
        writeDb(db);
        res.json({ success: true, message: 'Department created successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/departments/delete', (req, res) => {
    try {
        const { id } = req.body;
        const db = readDb();
        if (!db.departments) db.departments = [];

        db.departments = db.departments.filter(d => d.id != id);
        writeDb(db);
        res.json({ success: true, message: 'Department removed successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/hr/departments', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'departments.html'));
});

// --- SETTINGS PERSISTENCE API ---
app.get('/api/settings', (req, res) => {
    try {
        const db = readDb();
        if (!db.settings) {
            db.settings = {
                companyName: "CLICKORMEDIA PRIVATE LIMITED",
                cin: "U72900DL2024PTC123456",
                hrEmail: "hr@clickormedia.co.in",
                location: "Sanat Nagar, Jammu & Kashmir, India",
                paidLeaves: 18,
                casualLeaves: 12,
                sickLeaves: 10,
                pfContribution: "12% of Basic Salary",
                cutoffDate: "25th of every month",
                shiftStartTime: "10:00 AM", // Yahan apni default start time likhein
                shiftEndTime: "06:00 PM",   // Yahan apni default end time likhein
                gracePeriod: "5"            // Yahan grace period likhein
            };
            writeDb(db);
        }
        res.json({ success: true, settings: db.settings });
    } catch (err) {
        res.status(500).json({ success: false, settings: {} });
    }
});

app.post('/api/settings/save', (req, res) => {
    try {
        const { companyName, cin, hrEmail, location, paidLeaves, casualLeaves, sickLeaves, pfContribution, cutoffDate } = req.body;
        const db = readDb();
       
        db.settings = {
            ...db.settings,
            companyName,
            cin,
            hrEmail,
            location,
            paidLeaves: parseInt(paidLeaves) || 18,
            casualLeaves: parseInt(casualLeaves) || 12,
            sickLeaves: parseInt(sickLeaves) || 10,
            pfContribution,
            cutoffDate
        };

        writeDb(db);
        res.json({ success: true, message: 'Settings saved successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/hr/settings', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'settings.html'));
});

// --- EMPLOYEE PORTAL API ---
app.get('/api/employee/stats', (req, res) => {
    try {
        const db = readDb();
        
        // Agar session mein user logged in hai toh uska naam lein, nahi toh query ya default Pranchal
        let empName = (req.session.user && req.session.user.name) ? req.session.user.name : (req.query.name || "Pranchal Rajpal");
       
        if (!db.payroll) db.payroll = [];
        let record = db.payroll.find(p => p.name && p.name.toLowerCase() === empName.toLowerCase()) || db.payroll[0] || {
            baseNum: 25000,
            leaveBalance: 4,
            leaveLogs: []
        };

        let leavesTaken = record.leaveLogs ? record.leaveLogs.length : 0;
        let remainingBalance = Math.max(0, (record.leaveBalance || 4) - leavesTaken);
        let netPayout = record.baseNum || 25000;

        res.json({
            success: true,
            employee: {
                name: record.name || empName,
                email: record.email || `${empName.toLowerCase().replace(/\s+/g, '')}@clickormedia.co.in`,
                dept: record.dept || "Software Engineering",
                leaveBalance: remainingBalance,
                attendancePercentage: "96.5%",
                lastPayout: "₹" + netPayout.toLocaleString('en-IN'),
                recentLeaves: record.leaveLogs || []
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// --- EMPLOYEE PORTAL PAGE ROUTES ---
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
app.post('/api/employee/punch', (req, res) => {
    try {
        const { name, email, action, time, location } = req.body;
        const db = readDb();
        if (!db.attendance) db.attendance = [];

        const todayDate = new Date().toISOString().split('T')[0];

        let existingLog = db.attendance.find(log => log.email.toLowerCase() === (email || "").toLowerCase() && log.date === todayDate);

        if (action === 'IN') {
            if (!existingLog) {
                db.attendance.unshift({
                    name: name || "Employee",
                    email: email || "employee@clickormedia.co.in",
                    dept: "Software Engineering",
                    role: "Software Engineer",
                    date: todayDate,
                    checkInTime: time,
                    checkInLoc: location,
                    checkOutTime: "--:--",
                    checkOutLoc: "Pending",
                    status: "On Time",
                    avatar: "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&h=80&fit=crop&crop=faces"
                });
            } else {
                existingLog.checkInTime = time;
                existingLog.checkInLoc = location;
            }
        } else if (action === 'OUT') {
            if (existingLog) {
                existingLog.checkOutTime = time;
                existingLog.checkOutLoc = location;
            } else {
                db.attendance.unshift({
                    name: name || "Employee",
                    email: email || "employee@clickormedia.co.in",
                    dept: "Software Engineering",
                    role: "Software Engineer",
                    date: todayDate,
                    checkInTime: "09:00 AM",
                    checkInLoc: "Office HQ",
                    checkOutTime: time,
                    checkOutLoc: location,
                    status: "On Time",
                    avatar: "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&h=80&fit=crop&crop=faces"
                });
            }
        }

        writeDb(db);
        res.json({ success: true, message: `Punch ${action} recorded and synced to HR portal successfully!` });
    } catch (err) {
        console.error('Error recording punch:', err);
        res.status(500).json({ success: false, message: 'Server error during punch recording' });
    }
});

// --- API: Get Today's Punch Status for Employee ---
app.get('/api/employee/punch-status', (req, res) => {
    try {
        const email = req.query.email || (req.session.user ? req.session.user.email : "");
        const db = readDb();
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
app.get('/api/employee/payroll', (req, res) => {
    try {
        const db = readDb();
        if (!db.payroll) db.payroll = [];

        let currentUserName = req.query.name || (req.session.user ? req.session.user.name : "Pranchal Rajpal");
       
        let userPayroll = db.payroll.find(p => p.name && p.name.toLowerCase() === currentUserName.toLowerCase());
       
        if (!userPayroll) {
            userPayroll = db.payroll.find(p => p.name && p.name.toLowerCase().includes("pranchal")) || db.payroll[1] || db.payroll[0];
        }

        res.json({ success: true, payroll: userPayroll });
    } catch (err) {
        console.error('Error fetching employee payroll:', err);
        res.status(500).json({ success: false, payroll: null });
    }
});

// Employee Payroll Page Route
app.get('/employee/payroll', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'emp_payroll.html'));
});

// Employee Holiday Calendar Page Route
app.get('/employee/holidaycalendar', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'emp_holidaycalendar.html'));
});

// Employee Account Settings Page Route
app.get('/employee/settings', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'emp_settings.html'));
});

// Start listening on port 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

// API: Edit Employee Details & Department
app.put('/api/employees/edit/:id', (req, res) => {
    try {
        const empId = req.params.id;
        const { name, email, designation, department } = req.body;
        const db = readDb();

        if (db.users) {
            let user = db.users.find(u => u._id === empId || u.email.toLowerCase() === (email || "").toLowerCase());
            if (user) {
                user.name = name || user.name;
                user.email = email || user.email;
                user.designation = designation || user.designation;
                user.department = department || user.department;
                
                writeDb(db);
                console.log(`--- UPDATED EMPLOYEE & DEPT: ${user.name} -> ${user.department} ---`);
                return res.json({ success: true, message: 'Employee details updated successfully!' });
            }
        }
        res.status(404).json({ success: false, message: 'Employee not found' });
    } catch (err) {
        console.error('Error updating employee:', err);
        res.status(500).json({ success: false, message: 'Server error while updating employee' });
    }
});
