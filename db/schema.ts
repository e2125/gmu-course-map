import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const plans = sqliteTable("plans", {
  id: text("id").primaryKey(),
  editTokenHash: text("edit_token_hash").notNull(),
  name: text("name").notNull(),
  programId: text("program_id").notNull(),
  completedCodes: text("completed_codes").notNull().default("[]"),
  transferredCodes: text("transferred_codes").notNull().default("[]"),
  plannedCodes: text("planned_codes").notNull().default("[]"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
