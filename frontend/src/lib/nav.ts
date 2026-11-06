import type { ComponentType } from 'react';
import {
  Activity, BarChart3, BedDouble, Boxes, Building2, CalendarClock, CalendarDays, ClipboardList, FlaskConical, HeartPulse, LayoutDashboard, Pill, Receipt, ShieldCheck, Siren, Stethoscope, Syringe, UserCog, Users,
} from 'lucide-react';

export interface NavItem { to: string; labelKey: string; icon: ComponentType<{ className?: string }>; perms: string[]; /** key pressed after "g" */ key?: string }
export interface NavGroup { labelKey: string; items: NavItem[] }

/** Single source for the sidebar, the command palette and the "g then letter" shortcuts. Permissions mirror the backend guards. */
export const NAV_GROUPS: NavGroup[] = [
  { labelKey: 'group.myCare', items: [{ to: '/portal', labelKey: 'nav.portal', icon: HeartPulse, perms: ['portal.access'], key: 'o' }] },
  { labelKey: 'group.overview', items: [{ to: '/dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard, perms: ['dashboard.read'], key: 'd' }] },
  {
    labelKey: 'group.clinical', items: [
      { to: '/patients', labelKey: 'nav.patients', icon: Users, perms: ['patients.read_all', 'patients.read_scoped'], key: 'p' },
      { to: '/appointments', labelKey: 'nav.appointments', icon: CalendarDays, perms: ['appointments.read'], key: 'a' },
      { to: '/consultations', labelKey: 'nav.consultations', icon: ClipboardList, perms: ['consultations.read'], key: 'c' },
      { to: '/triage', labelKey: 'nav.triage', icon: Siren, perms: ['triage.read'], key: 'e' },
      { to: '/admissions', labelKey: 'nav.admissions', icon: BedDouble, perms: ['admissions.read'], key: 'n' },
      { to: '/mar', labelKey: 'nav.mar', icon: Syringe, perms: ['mar.read'], key: 'm' },
      { to: '/laboratory', labelKey: 'nav.laboratory', icon: FlaskConical, perms: ['lab.read'], key: 'l' },
      { to: '/pharmacy', labelKey: 'nav.pharmacy', icon: Pill, perms: ['pharmacy.read'], key: 'h' },
    ],
  },
  {
    labelKey: 'group.operations', items: [
      { to: '/staff', labelKey: 'nav.staff', icon: Stethoscope, perms: ['staff.read'], key: 's' },
      { to: '/roster', labelKey: 'nav.roster', icon: CalendarClock, perms: ['staff.read'], key: 'w' },
      { to: '/departments', labelKey: 'nav.departments', icon: Building2, perms: ['departments.read'], key: 'u' },
      { to: '/billing', labelKey: 'nav.billing', icon: Receipt, perms: ['billing.read'], key: 'b' },
      { to: '/inventory', labelKey: 'nav.inventory', icon: Boxes, perms: ['inventory.read'], key: 'i' },
      { to: '/reports', labelKey: 'nav.reports', icon: BarChart3, perms: ['reports.read'], key: 'r' },
    ],
  },
  {
    labelKey: 'group.system', items: [
      { to: '/admin', labelKey: 'nav.admin', icon: UserCog, perms: ['users.manage'], key: 'x' },
      { to: '/assessment', labelKey: 'nav.assessment', icon: ShieldCheck, perms: ['assessment.read'], key: 'y' },
    ],
  },
];

export const ALL_NAV: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

export const firstAllowedRoute = (can: (...p: string[]) => boolean) => ALL_NAV.find((n) => can(...n.perms))?.to ?? '/profile';

export const ActivityIcon = Activity;
