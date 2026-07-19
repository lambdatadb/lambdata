import { motion } from "framer-motion";
import type { Database } from "@kilndb/shared";
import { DatabaseCard } from "./DatabaseCard";

export function DatabaseGrid({ databases }: { databases: Database[] }) {
  return (
    <motion.div
      layout
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
    >
      {databases.map((d) => (
        <DatabaseCard key={d.id} db={d} />
      ))}
    </motion.div>
  );
}
