CREATE TABLE "server_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"action" text NOT NULL,
	"spec" jsonb NOT NULL,
	"timezone" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_result" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "auto_restart" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "server_schedules" ADD CONSTRAINT "server_schedules_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_schedules" ADD CONSTRAINT "server_schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "server_schedules_due_idx" ON "server_schedules" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "server_schedules_server_idx" ON "server_schedules" USING btree ("server_id");