CREATE TABLE "server_moderators" (
	"server_id" uuid NOT NULL,
	"steam_id64" text NOT NULL,
	"name" text,
	"profile_url" text NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "pending_restart" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "server_moderators" ADD CONSTRAINT "server_moderators_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_moderators" ADD CONSTRAINT "server_moderators_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "server_moderators_uq" ON "server_moderators" USING btree ("server_id","steam_id64");