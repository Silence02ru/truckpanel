ALTER TABLE "servers" ADD COLUMN "logon_token_enc" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "logon_token_hash" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "session_search_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "servers_logon_token_hash_uq" ON "servers" USING btree ("logon_token_hash");