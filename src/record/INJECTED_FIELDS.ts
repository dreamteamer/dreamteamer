/** The fields every collection has. `created` is stored (engine-written); `id` and `last_modified` are
 *  computed on read. */
export const INJECTED_FIELDS = {
  id: { type: "string", title: "Id", virtual: true, description: "The record's path inside its collection." },
  created: {
    type: "datetime",
    title: "Created",
    derived: true,
    description:
      "When the record was first written. Stamped by the engine at add; read from the id's date or the first commit for a record written before it existed.",
  },
  last_modified: {
    type: "datetime",
    title: "Last modified",
    virtual: true,
    description: "When the record was last committed, from git.",
  },
}
