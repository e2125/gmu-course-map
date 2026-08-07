CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`edit_token_hash` text NOT NULL,
	`name` text NOT NULL,
	`program_id` text NOT NULL,
	`completed_codes` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
