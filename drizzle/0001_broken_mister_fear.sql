ALTER TABLE `plans` ADD `transferred_codes` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `plans` ADD `planned_codes` text DEFAULT '[]' NOT NULL;