import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import Layout, { firstAllowed } from './components/Layout';
import { Alert, Spinner } from './components/ui';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Patients from './pages/Patients';
import PatientDetail from './pages/PatientDetail';
import Appointments from './pages/Appointments';
import Admissions from './pages/Admissions';
import Staff from './pages/Staff';
import Departments from './pages/Departments';
import Laboratory from './pages/Laboratory';
import Pharmacy from './pages/Pharmacy';
import Billing from './pages/Billing';
import Reports from './pages/Reports';
import Admin from './pages/Admin';
import Assessment from './pages/Assessment';
import Profile from './pages/Profile';
import Consultations from './pages/Consultations';
import Consultation from './pages/Consultation';
import Triage from './pages/Triage';
import Mar from './pages/Mar';
import Inventory from './pages/Inventory';
import Roster from './pages/Roster';
import Portal from './pages/Portal';

function Guard({ perms, children }: { perms: string[]; children: ReactNode }) {
  const { can } = useAuth();
  // UI guard only; every API call is authorised again by the backend.
  return can(...perms) ? <>{children}</> : <Alert tone="warn">You do not have access to this area.</Alert>;
}

export default function App() {
  const { user, loading, backendDown, can } = useAuth();
  if (loading) return <Spinner label="Starting MediCore" />;
  if (backendDown) return <div className="p-6"><Alert>Cannot reach the MediCore API on 127.0.0.1:4000. Start the backend (see README) and reload.</Alert></div>;
  if (!user) return <Routes><Route path="*" element={<Login />} /></Routes>;
  const g = (perms: string[], el: ReactNode) => <Guard perms={perms}>{el}</Guard>;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to={firstAllowed(can)} replace />} />
        <Route path="portal" element={g(['portal.access'], <Portal />)} />
        <Route path="dashboard" element={g(['dashboard.read'], <Dashboard />)} />
        <Route path="consultations" element={g(['consultations.read'], <Consultations />)} />
        <Route path="consultations/:id" element={g(['consultations.read'], <Consultation />)} />
        <Route path="triage" element={g(['triage.read'], <Triage />)} />
        <Route path="mar" element={g(['mar.read'], <Mar />)} />
        <Route path="inventory" element={g(['inventory.read'], <Inventory />)} />
        <Route path="roster" element={g(['staff.read'], <Roster />)} />
        <Route path="patients" element={g(['patients.read_all', 'patients.read_scoped'], <Patients />)} />
        <Route path="patients/:id" element={g(['patients.read_all', 'patients.read_scoped'], <PatientDetail />)} />
        <Route path="appointments" element={g(['appointments.read'], <Appointments />)} />
        <Route path="admissions" element={g(['admissions.read'], <Admissions />)} />
        <Route path="staff" element={g(['staff.read'], <Staff />)} />
        <Route path="departments" element={g(['departments.read'], <Departments />)} />
        <Route path="laboratory" element={g(['lab.read'], <Laboratory />)} />
        <Route path="pharmacy" element={g(['pharmacy.read'], <Pharmacy />)} />
        <Route path="billing" element={g(['billing.read'], <Billing />)} />
        <Route path="reports" element={g(['reports.read'], <Reports />)} />
        <Route path="admin" element={g(['users.manage'], <Admin />)} />
        <Route path="assessment" element={g(['assessment.read'], <Assessment />)} />
        <Route path="profile" element={<Profile />} />
        <Route path="*" element={<Alert tone="warn">Page not found.</Alert>} />
      </Route>
    </Routes>
  );
}
