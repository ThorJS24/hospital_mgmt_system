export const ROLES = [
  'administrator',
  'doctor',
  'nurse',
  'receptionist',
  'lab_technician',
  'pharmacist',
  'billing_officer',
  'security_assessor',
  'patient',
] as const;
export type RoleCode = (typeof ROLES)[number];

export const ROLE_NAMES: Record<RoleCode, string> = {
  administrator: 'Administrator',
  doctor: 'Doctor',
  nurse: 'Nurse',
  receptionist: 'Receptionist',
  lab_technician: 'Laboratory Technician',
  pharmacist: 'Pharmacist',
  billing_officer: 'Billing Officer',
  security_assessor: 'Security Assessor',
  patient: 'Patient',
};

/**
 * Permission matrix. This is the single source of truth: it is seeded into the
 * roles/permissions tables and evaluated from the session at request time.
 * Note that `administrator` deliberately has NO assessment.* permission.
 * Clinical reads (clinical.read) are further scoped to the care team for doctors/nurses.
 */
export const PERMISSIONS: Record<string, { description: string; roles: RoleCode[] }> = {
  'dashboard.read': { description: 'View dashboard', roles: ['administrator', 'doctor', 'nurse', 'receptionist', 'lab_technician', 'pharmacist', 'billing_officer'] },
  'patients.read_all': { description: 'View patient demographics for all patients', roles: ['administrator', 'receptionist', 'lab_technician', 'pharmacist', 'billing_officer'] },
  'patients.read_scoped': { description: 'View patients of own care team', roles: ['doctor', 'nurse'] },
  'patients.register': { description: 'Register patients', roles: ['administrator', 'receptionist', 'nurse'] },
  'patients.write': { description: 'Update patient records', roles: ['administrator', 'receptionist', 'doctor', 'nurse'] },
  'clinical.read': { description: 'View medical history and allergies', roles: ['administrator', 'doctor', 'nurse'] },
  'clinical.write': { description: 'Edit medical history, allergies and notes', roles: ['administrator', 'doctor', 'nurse'] },
  'documents.manage': { description: 'Upload and view patient documents', roles: ['administrator', 'receptionist', 'doctor', 'nurse'] },
  'appointments.read': { description: 'View appointments', roles: ['administrator', 'doctor', 'nurse', 'receptionist'] },
  'appointments.write': { description: 'Create and change appointments', roles: ['administrator', 'doctor', 'nurse', 'receptionist'] },
  'admissions.read': { description: 'View admissions and beds', roles: ['administrator', 'doctor', 'nurse', 'receptionist'] },
  'admissions.manage': { description: 'Admit, transfer and discharge', roles: ['administrator', 'doctor', 'nurse'] },
  'staff.read': { description: 'View staff directory', roles: ['administrator', 'doctor', 'nurse', 'receptionist', 'lab_technician', 'pharmacist', 'billing_officer'] },
  'staff.manage': { description: 'Manage staff records', roles: ['administrator'] },
  'departments.read': { description: 'View departments', roles: ['administrator', 'doctor', 'nurse', 'receptionist', 'lab_technician', 'pharmacist', 'billing_officer'] },
  'departments.manage': { description: 'Manage departments', roles: ['administrator'] },
  'lab.read': { description: 'View laboratory requests and results', roles: ['administrator', 'doctor', 'nurse', 'lab_technician'] },
  'lab.request': { description: 'Create laboratory requests', roles: ['administrator', 'doctor'] },
  'lab.result': { description: 'Enter results', roles: ['administrator', 'lab_technician'] },
  'lab.approve': { description: 'Approve results', roles: ['administrator', 'doctor'] },
  'pharmacy.read': { description: 'View medications and prescriptions', roles: ['administrator', 'doctor', 'nurse', 'pharmacist'] },
  'prescriptions.write': { description: 'Create prescriptions', roles: ['administrator', 'doctor'] },
  'prescriptions.dispense': { description: 'Dispense prescriptions', roles: ['administrator', 'pharmacist'] },
  'billing.read': { description: 'View invoices', roles: ['administrator', 'receptionist', 'billing_officer'] },
  'billing.write': { description: 'Create invoices and record payments', roles: ['administrator', 'billing_officer'] },
  'reports.read': { description: 'View operational reports', roles: ['administrator', 'billing_officer'] },
  'users.manage': { description: 'Manage application users and roles', roles: ['administrator'] },
  'config.manage': { description: 'Edit system configuration', roles: ['administrator'] },
  'audit.read': { description: 'Read audit events', roles: ['administrator'] },
  'consultations.read': { description: 'View consultations and ICD-10 codes', roles: ['administrator', 'doctor', 'nurse'] },
  'consultations.write': { description: 'Write and sign consultations', roles: ['doctor'] },
  'vitals.write': { description: 'Record patient vitals', roles: ['administrator', 'doctor', 'nurse'] },
  'mar.read': { description: 'View the medication administration record', roles: ['administrator', 'doctor', 'nurse'] },
  'mar.schedule': { description: 'Schedule medication doses for admitted patients', roles: ['administrator', 'doctor'] },
  'mar.administer': { description: 'Record administered doses', roles: ['administrator', 'nurse'] },
  'discharge.read': { description: 'View discharge summaries', roles: ['administrator', 'doctor', 'nurse'] },
  'discharge.write': { description: 'Write discharge summaries', roles: ['administrator', 'doctor'] },
  'triage.read': { description: 'View the triage queue', roles: ['administrator', 'doctor', 'nurse', 'receptionist'] },
  'triage.write': { description: 'Register and triage arrivals', roles: ['administrator', 'nurse', 'receptionist'] },
  'triage.treat': { description: 'Start and complete emergency treatment', roles: ['administrator', 'doctor', 'nurse'] },
  'prescriptions.refill': { description: 'Dispense prescription refills', roles: ['administrator', 'pharmacist'] },
  'inventory.read': { description: 'View pharmacy inventory and suppliers', roles: ['administrator', 'pharmacist'] },
  'inventory.manage': { description: 'Receive and adjust stock, manage suppliers', roles: ['administrator', 'pharmacist'] },
  'roster.manage': { description: 'Edit staff shifts', roles: ['administrator'] },
  'leave.request': { description: 'Request leave', roles: ['administrator', 'doctor', 'nurse', 'receptionist', 'lab_technician', 'pharmacist', 'billing_officer'] },
  'leave.decide': { description: 'Approve or reject leave', roles: ['administrator'] },
  'claims.read': { description: 'View insurance claims', roles: ['administrator', 'receptionist', 'billing_officer'] },
  'claims.write': { description: 'Submit insurance claims', roles: ['administrator', 'billing_officer'] },
  'claims.decide': { description: 'Record insurer decisions on claims', roles: ['administrator', 'billing_officer'] },
  'refunds.write': { description: 'Issue refunds', roles: ['administrator', 'billing_officer'] },
  'portal.access': { description: 'Use the patient portal for own records', roles: ['patient'] },
  'assessment.read': { description: 'View assessment register, manifest and test cases', roles: ['security_assessor'] },
  'assessment.write': { description: 'Record findings, results and evidence', roles: ['security_assessor'] },
  'assessment.export': { description: 'Export register and generate reports', roles: ['security_assessor'] },
};

export function permissionsFor(role: string): string[] {
  return Object.entries(PERMISSIONS)
    .filter(([, v]) => (v.roles as string[]).includes(role))
    .map(([k]) => k);
}
