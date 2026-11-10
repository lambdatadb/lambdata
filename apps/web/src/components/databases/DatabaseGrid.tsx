import type { Database } from "@lambdata/shared";
import { DatabaseCard } from "./DatabaseCard";

export function DatabaseGrid({ databases }: { databases: Database[] }) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {databases.map((db) => (
        <li key={db.id} className="min-w-0">
          <DatabaseCard db={db} />
        </li>
      ))}
    </ul>
  );
}
