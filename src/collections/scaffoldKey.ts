/** `acme-crm` → `ACME_CRM_TOKEN`: the one env key the scaffolded unit declares. */
export const scaffoldKey = (id: string): string => `${id.toUpperCase().replace(/-/g, "_")}_TOKEN`
