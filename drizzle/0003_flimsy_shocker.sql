ALTER TABLE `plans` ADD `earned_credits` real;--> statement-breakpoint
ALTER TABLE `plans` ADD `audit_completed_codes` text DEFAULT '[]' NOT NULL;