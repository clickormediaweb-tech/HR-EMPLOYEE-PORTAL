// API: Edit Employee Details
app.put('/api/employees/edit/:id', (req, res) => {
    try {
        const empId = req.params.id;
        const { name, email, designation } = req.body;
        const db = readDb();

        if (db.users) {
            let user = db.users.find(u => u._id === empId || u.email.toLowerCase() === (email || "").toLowerCase());
            if (user) {
                user.name = name || user.name;
                user.email = email || user.email;
                user.designation = designation || user.designation;
               
                writeDb(db);
                console.log(`--- UPDATED EMPLOYEE: ${user.name} ---`);
                return res.json({ success: true, message: 'Employee details updated successfully!' });
            }
        }
        res.status(404).json({ success: false, message: 'Employee not found' });
    } catch (err) {
        console.error('Error updating employee:', err);
        res.status(500).json({ success: false, message: 'Server error while updating employee' });
    }
});
