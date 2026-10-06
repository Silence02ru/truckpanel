CREATE TABLE "discord_integrations" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"webhook_enc" text,
	"webhook_id" text,
	"message_id" text,
	"interval_sec" integer DEFAULT 60 NOT NULL,
	"locale" text DEFAULT 'ru' NOT NULL,
	"sections" jsonb NOT NULL,
	"notify_status" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'disabled' NOT NULL,
	"last_error_code" text,
	"last_success_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discord_integrations" ADD CONSTRAINT "discord_integrations_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;