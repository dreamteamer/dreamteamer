// The synthetic clinic as COMPILED v2 descriptors — the authored keys verbatim plus the `compiled`
// block — in the shape of the design's worked example (§3.9, §6.6). The display contract's unit tests
// read these, so they need no workspace and no compile. Invented names only: this engine is published.

const INJECTED = {
	id: { type: 'string', virtual: true, description: 'The record\'s path inside its collection.' },
	created: { type: 'datetime', derived: true, description: 'When the record was first written.' },
	last_modified: { type: 'datetime', virtual: true, description: 'When the record was last committed, from git.' },
};

/** A compiled collection: `authored` keys verbatim, then a `compiled` block resolving `fields`. */
export function compiledCollection(name, { authored = {}, fields = {}, defaults = {}, runtime = false, mirrors = [] } = {}) {
	const bare = name.split('/').pop();
	return {
		name,
		...authored,
		compiled: {
			defaults: {
				title: bare.charAt(0).toUpperCase() + bare.slice(1),
				singular: name.replace(/s$/, ''),
				storage: { path: `data/${name}`, format: 'md', shape: 'file', suffix: bare.replace(/s$/, '') },
				display: { list: { layout: 'table' }, record: { layout: 'page' } },
				...defaults,
			},
			module: 'clinic',
			repo: '.',
			runtime,
			mirrors,
			overlaid_by: [],
			unresolved_peers: [],
			fields: { ...(runtime ? { id: INJECTED.id, last_modified: INJECTED.last_modified } : INJECTED), ...fields },
			json_schema: { type: 'object', properties: {} },
		},
	};
}

export const VISITS = compiledCollection('health/visits', {
	authored: {
		record_title: '{{ reason }} · {{ date }}',
		description: 'One consultation between a patient and a doctor.',
		sensitive: true,
		storage: { under: { parent: 'patient', subfolder: 'visits' } },
		display: {
			nav: { icon: 'stethoscope', order: 20, section: 'care' },
			list: { columns: ['reason', 'patient', 'date', 'doctor', 'kind', 'status', 'fee', 'contact_email'], sort: '-date', options: { page_size: 50 } },
			record: { subtitle: '{{ patient }} · {{ kind }}', badge: 'status', color_by: 'kind' },
			form: {
				sections: [
					{ title: 'Visit', fields: ['reason', 'patient', 'doctor', 'date', 'checked_in', 'kind', 'status', 'contact_email'] },
					{ title: 'Findings', fields: ['measurements', 'diagnosis_codes', 'prescriptions', 'referral', 'evidence'] },
					{ title: 'Billing', fields: ['duration_min', 'fee', 'paid', 'invoice'] },
				],
			},
		},
	},
	defaults: {
		title: 'Visits',
		singular: 'health/visit',
		storage: { path: 'data/health/visits', format: 'md', shape: 'file', suffix: 'visit' },
		display: { list: { layout: 'table' }, record: { layout: 'page' } },
		fields: { patient: { title: 'Patient', on_delete: 'restrict' }, doctor: { title: 'Doctor', on_delete: 'restrict' } },
	},
	mirrors: ['prescriptions', 'insurer_claim'],
	fields: {
		reason: { type: 'string', required: true, title: 'Reason for visit', display: { placeholder: 'Reason in the patient\'s words', direction: 'rtl' }, description: 'In the patient\'s own words.' },
		patient: { type: 'health/patients', required: true, title: 'Patient', on_delete: 'restrict', description: 'Who was seen.' },
		doctor: { type: 'health/doctors', required: true, title: 'Doctor', on_delete: 'restrict' },
		date: { type: 'date', required: true, title: 'Date' },
		checked_in: { type: 'datetime', title: 'Checked In', display: { hidden: ['list'] } },
		kind: {
			type: 'string', required: true, default: 'follow-up', title: 'Kind',
			enum: {
				intake: { label: 'Intake', icon: 'person-add', color: 'charts.blue', description: 'First visit.' },
				'follow-up': { label: 'Follow-up', icon: 'history', color: 'charts.green' },
				urgent: { label: 'Urgent', icon: 'alert', color: 'charts.red', background: 'charts.red' },
			},
		},
		status: { type: 'string', default: 'booked', title: 'Status', enum: ['booked', 'arrived', 'seen', 'no-show', 'cancelled'] },
		duration_min: { type: 'integer', minimum: 5, maximum: 180, title: 'Duration Min', display: { unit: 'min', width: 6 } },
		fee: { type: 'number', minimum: 0, title: 'Fee', display: { unit: 'currency', unit_field: 'currency', viewer: 'money', editor: 'money-input', options: { precision: 2 } } },
		currency: { type: 'string', default: 'ILS', pattern: '^[A-Z]{3}$', title: 'Currency', display: { hidden: ['list', 'form'] } },
		paid: { type: 'boolean', default: false, title: 'Paid' },
		measurements: {
			type: 'object', many: true, title: 'Measurements', item_title: '{{ analyte }} {{ value }} {{ unit }}',
			fields: { analyte: { type: 'string', required: true }, value: { type: 'number', required: true }, unit: { type: 'string' } },
		},
		diagnosis_codes: { type: 'map', values: 'string', title: 'Diagnosis Codes' },
		prescriptions: { type: 'health/prescriptions', many: true, mirror_of: 'visit', title: 'Prescriptions', description: 'Set `visit` on the prescription.' },
		invoice: { type: 'finance/income-events', unique: true, title: 'Invoice', on_delete: 'restrict' },
		referral: { type: ['health/referrals', 'health/lab-orders'], title: 'Referral', on_delete: 'set-null' },
		evidence: { type: 'reference', many: true, title: 'Evidence' },
		summary_url: { type: 'url', title: 'Summary Url', display: { editable: false } },
		contact_email: { type: 'email', sensitive: true, deprecated: true, title: 'Contact Email' },
		intake_code: { type: 'string', title: 'Intake Code', display: { editable: 'create', form_section: 'Billing' } },
		position: { type: 'position', title: 'Position' },
		author: { type: 'string', title: 'Author' },
		insurer_claim: { type: 'billing/claims', mirror_of: 'visit', title: 'Insurer Claim' },
		consultation_notes: { type: 'markdown', body: true, title: 'Consultation Notes', display: { direction: 'rtl' } },
	},
});

export const PATIENTS = compiledCollection('health/patients', {
	authored: {
		description: 'A person under this clinic\'s care.',
		storage: { shape: 'folder', entry: 'patient.md' },
		display: { nav: { icon: 'person', order: 10, section: 'care' } },
	},
	defaults: { record_title: '{{ name }}', storage: { path: 'data/health/patients', format: 'md', suffix: 'patient' } },
	mirrors: ['visits'],
	fields: {
		name: { type: 'string', required: true, title: 'Name' },
		doctors: { type: 'health/doctors', many: true, title: 'Doctors', on_delete: 'restrict' },
		visits: { type: 'health/visits', many: true, mirror_of: 'patient', title: 'Visits' },
		notes: { type: 'markdown', body: true, title: 'Notes' },
	},
});

export const PRESCRIPTIONS = compiledCollection('health/prescriptions', {
	authored: { description: 'One prescription written at a visit.' },
	fields: { visit: { type: 'health/visits', title: 'Visit', on_delete: 'restrict' } },
});

export const CLAIMS = compiledCollection('billing/claims', {
	authored: { description: 'One insurer claim.' },
	fields: { visit: { type: 'health/visits', unique: true, title: 'Visit', on_delete: 'restrict' } },
});

export const DOCTORS = compiledCollection('health/doctors', {
	authored: { description: 'A doctor.' },
	mirrors: ['patients'],
	fields: {
		name: { type: 'string', required: true, title: 'Name' },
		patients: { type: 'health/patients', many: true, mirror_of: 'doctors', title: 'Patients' },
	},
});

export const clinic = () => new Map([VISITS, PATIENTS, PRESCRIPTIONS, CLAIMS, DOCTORS].map((d) => [d.name, structuredClone(d)]));
