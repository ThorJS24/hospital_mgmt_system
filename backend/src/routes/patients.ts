import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Ctx } from '../middleware/context.js';
import { audit, can, requirePermission } from '../middleware/context.js';
import { HttpError, intParam, pageQuery, parse } from '../utils/http.js';
import { canAccessPatient, getPatient, listPatients, nextMrn } from '../services/patients.js';
import { randomToken } from '../utils/crypto.js';

const patientFields = z.object({
  first_name: z.string().trim().min(1).max(60),
  last_name: z.string().trim().min(1).max(60),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => new Date(d) <= new Date(), 'Date of birth cannot be in the future'),
  sex: z.enum(['Female', 'Male', 'Other']),
  phone: z.string().max(30).default(''),
  email: z.union([z.email().max(200), z.literal('')]).default(''),
  address: z.string().max(300).default(''),
  primary_doctor_id: z.number().int().positive().nullable().optional(),
});

/** Secure document upload constraints (HMS-V08 is the weakened variant). */
export const DOC_TYPES: Record<string, { mime: string; magic: (b: Buffer) => boolean }> = {
  '.pdf': { mime: 'application/pdf', magic: (b) => b.subarray(0, 5).toString() === '%PDF-' },
  '.png': { mime: 'image/png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  '.jpg': { mime: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  '.txt': { mime: 'text/plain', magic: (b) => !b.includes(0) },
};
export const MAX_UPLOAD = 512 * 1024;

export function patientRoutes({ db, cfg }: Ctx) {
  const r = Router();

  r.get('/patients', requirePermission('patients.read_all', 'patients.read_scoped'), async (req, res) => {
    res.json(await listPatients(db, req.user!, pageQuery(req.query, 'name'), req.query.status ? String(req.query.status) : undefined));
  });

  r.post('/patients', requirePermission('patients.register'), async (req, res) => {
    const b = parse(patientFields, req.body);
    const mrn = await nextMrn(db);
    const { rows } = await db.query(
      'INSERT INTO patients(mrn,first_name,last_name,dob,sex,phone,email,address,primary_doctor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [mrn, b.first_name, b.last_name, b.dob, b.sex, b.phone, b.email, b.address, b.primary_doctor_id ?? null],
    );
    await audit(db, req, 'patient_register', 'patient', rows[0].id);
    res.status(201).json({ id: rows[0].id, mrn });
  });

  r.get('/patients/:id', requirePermission('patients.read_all', 'patients.read_scoped'), async (req, res) => {
    res.json(await getPatient(db, req.user!, intParam(req.params.id)));
  });

  r.patch('/patients/:id', requirePermission('patients.write'), async (req, res) => {
    const id = intParam(req.params.id);
    if (!(await canAccessPatient(db, req.user!, id))) throw new HttpError(404, 'Patient not found');
    const b = parse(
      patientFields.partial().extend({ status: z.enum(['Active', 'Inactive', 'Deceased']).optional(), notes: z.string().max(4000).optional() }).strict(),
      req.body,
    );
    if (b.notes !== undefined && !can(req, 'clinical.write')) throw new HttpError(403, 'Clinical notes require clinical write permission');
    const cols = Object.entries(b).filter(([, v]) => v !== undefined);
    if (!cols.length) throw new HttpError(400, 'No fields to update');
    const sets = cols.map(([k], i) => `${k}=$${i + 2}`).join(', ');
    await db.query(`UPDATE patients SET ${sets}, updated_at=now() WHERE id=$1`, [id, ...cols.map(([, v]) => v)]);
    await audit(db, req, 'patient_update', 'patient', id, `fields=${cols.map(([k]) => k).join(',')}`);
    res.json({ ok: true });
  });

  // clinical sub-records
  r.post('/patients/:id/allergies', requirePermission('clinical.write'), async (req, res) => {
    const id = intParam(req.params.id);
    if (!(await canAccessPatient(db, req.user!, id))) throw new HttpError(404, 'Patient not found');
    const b = parse(z.object({ allergen: z.string().min(1).max(80), reaction: z.string().max(120).default(''), severity: z.enum(['Mild', 'Moderate', 'Severe']) }), req.body);
    await db.query('INSERT INTO patient_allergies(patient_id,allergen,reaction,severity) VALUES ($1,$2,$3,$4)', [id, b.allergen, b.reaction, b.severity]);
    await audit(db, req, 'allergy_add', 'patient', id);
    res.status(201).json({ ok: true });
  });
  r.post('/patients/:id/history', requirePermission('clinical.write'), async (req, res) => {
    const id = intParam(req.params.id);
    if (!(await canAccessPatient(db, req.user!, id))) throw new HttpError(404, 'Patient not found');
    const b = parse(z.object({ condition: z.string().min(1).max(120), diagnosed_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), notes: z.string().max(500).default('') }), req.body);
    await db.query('INSERT INTO medical_histories(patient_id,condition,diagnosed_on,notes) VALUES ($1,$2,$3,$4)', [id, b.condition, b.diagnosed_on ?? null, b.notes]);
    await audit(db, req, 'history_add', 'patient', id);
    res.status(201).json({ ok: true });
  });
  r.post('/patients/:id/contacts', requirePermission('patients.write'), async (req, res) => {
    const id = intParam(req.params.id);
    if (!(await canAccessPatient(db, req.user!, id))) throw new HttpError(404, 'Patient not found');
    const b = parse(z.object({ name: z.string().min(1).max(80), relationship: z.string().min(1).max(40), phone: z.string().min(3).max(30) }), req.body);
    await db.query('INSERT INTO patient_contacts(patient_id,name,relationship,phone) VALUES ($1,$2,$3,$4)', [id, b.name, b.relationship, b.phone]);
    res.status(201).json({ ok: true });
  });

  // ---- secure documents ----------------------------------------------------
  r.post('/patients/:id/documents', requirePermission('documents.manage'), async (req, res) => {
    const id = intParam(req.params.id);
    if (!(await canAccessPatient(db, req.user!, id))) throw new HttpError(404, 'Patient not found');
    const b = parse(z.object({ filename: z.string().min(1).max(120), content_base64: z.string().max(MAX_UPLOAD * 2) }), req.body);
    const ext = path.extname(b.filename).toLowerCase();
    const spec = DOC_TYPES[ext];
    const buf = Buffer.from(b.content_base64, 'base64');
    if (!spec) throw new HttpError(400, `File type ${ext || '(none)'} is not allowed`);
    if (buf.length === 0 || buf.length > MAX_UPLOAD) throw new HttpError(400, `File must be between 1 byte and ${MAX_UPLOAD} bytes`);
    if (!spec.magic(buf)) throw new HttpError(400, 'File content does not match its extension');
    fs.mkdirSync(cfg.uploadDir, { recursive: true });
    const stored = `${randomToken(16)}${ext}`;
    fs.writeFileSync(path.join(cfg.uploadDir, stored), buf);
    const safeName = path.basename(b.filename).replace(/[^\w.\- ]/g, '_');
    const { rows } = await db.query('INSERT INTO patient_documents(patient_id,filename,stored_name,content_type,size_bytes,uploaded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [id, safeName, stored, spec.mime, buf.length, req.user!.id]);
    await audit(db, req, 'document_upload', 'patient', id);
    res.status(201).json({ id: rows[0].id });
  });

  r.get('/documents/:id', requirePermission('documents.manage'), async (req, res) => {
    const d = (await db.query('SELECT * FROM patient_documents WHERE id=$1', [intParam(req.params.id)])).rows[0];
    if (!d || !(await canAccessPatient(db, req.user!, d.patient_id))) throw new HttpError(404, 'Document not found');
    res.setHeader('Content-Type', d.content_type);
    res.setHeader('Content-Disposition', `attachment; filename="${d.filename.replace(/"/g, '')}"`);
    res.send(fs.readFileSync(path.join(cfg.uploadDir, d.stored_name)));
  });

  return r;
}
