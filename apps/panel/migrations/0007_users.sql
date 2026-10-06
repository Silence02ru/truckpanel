CREATE TABLE "server_members" (
	"server_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_members_server_id_user_id_pk" PRIMARY KEY("server_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "user_invites" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DATA TYPE text USING "role"::text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "quota_servers" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "quota_memory_mb" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "quota_cpus" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "quota_backup_mb" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "server_members" ADD CONSTRAINT "server_members_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_members" ADD CONSTRAINT "server_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_members" ADD CONSTRAINT "server_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_invites" ADD CONSTRAINT "user_invites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_invites" ADD CONSTRAINT "user_invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "server_members_user_idx" ON "server_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "server_members_owner_uq" ON "server_members" USING btree ("server_id") WHERE "server_members"."role" = 'owner';--> statement-breakpoint
CREATE INDEX "user_invites_user_idx" ON "user_invites" USING btree ("user_id");--> statement-breakpoint
-- Data: per-panel roles become per-server roles on every existing server (docs/PHASE-7.md §7.2).
INSERT INTO "server_members" ("server_id", "user_id", "role") SELECT s."id", u."id", u."role" FROM "users" u CROSS JOIN "servers" s WHERE u."role" IN ('manager', 'moderator', 'viewer');--> statement-breakpoint
INSERT INTO "server_members" ("server_id", "user_id", "role") SELECT s."id", (SELECT "id" FROM "users" WHERE "role" = 'administrator' ORDER BY "created_at" LIMIT 1), 'owner' FROM "servers" s WHERE EXISTS (SELECT 1 FROM "users" WHERE "role" = 'administrator');--> statement-breakpoint
UPDATE "users" SET "role" = 'user' WHERE "role" <> 'administrator';--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("role" IN ('administrator', 'user'));--> statement-breakpoint
ALTER TABLE "server_members" ADD CONSTRAINT "server_members_role_check" CHECK ("role" IN ('owner', 'manager', 'moderator', 'viewer'));--> statement-breakpoint
DROP TYPE "public"."role";