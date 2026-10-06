ALTER TABLE "sessions" ADD COLUMN "public_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "theme" text DEFAULT 'dark' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "steam_id64" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "steam_name" text;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_public_id_uq" ON "sessions" USING btree ("public_id");