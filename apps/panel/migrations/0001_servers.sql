CREATE TYPE "public"."game" AS ENUM('ets2', 'ats');--> statement-breakpoint
CREATE TYPE "public"."port_kind" AS ENUM('connection', 'query', 'connection_virtual', 'query_virtual');--> statement-breakpoint
CREATE TYPE "public"."port_space" AS ENUM('host', 'virtual');--> statement-breakpoint
CREATE TYPE "public"."server_state" AS ENUM('NEW', 'INSTALLING', 'AWAITING_PACKAGES', 'STOPPED', 'STARTING', 'ONLINE', 'STOPPING', 'UPDATING', 'ERROR', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."task_kind" AS ENUM('install', 'update', 'start', 'stop', 'restart', 'kill', 'delete');--> statement-breakpoint
CREATE TYPE "public"."task_state" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "server_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"values" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_ports" (
	"server_id" uuid NOT NULL,
	"kind" "port_kind" NOT NULL,
	"space" "port_space" NOT NULL,
	"port" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"game" "game" NOT NULL,
	"state" "server_state" DEFAULT 'NEW' NOT NULL,
	"desired_running" boolean DEFAULT false NOT NULL,
	"memory_mb" integer DEFAULT 2048 NOT NULL,
	"cpus" double precision DEFAULT 1 NOT NULL,
	"last_error" text,
	"last_error_code" text,
	"has_packages_sii" boolean DEFAULT false NOT NULL,
	"has_packages_dat" boolean DEFAULT false NOT NULL,
	"installed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid,
	"kind" "task_kind" NOT NULL,
	"state" "task_state" DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"stage" text,
	"message" text,
	"code" text,
	"log" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "server_configs" ADD CONSTRAINT "server_configs_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_configs" ADD CONSTRAINT "server_configs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_ports" ADD CONSTRAINT "server_ports_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "server_configs_version_uq" ON "server_configs" USING btree ("server_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "server_ports_space_port_uq" ON "server_ports" USING btree ("space","port");--> statement-breakpoint
CREATE UNIQUE INDEX "server_ports_server_kind_uq" ON "server_ports" USING btree ("server_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "servers_name_lower_uq" ON "servers" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "tasks_server_idx" ON "tasks" USING btree ("server_id","created_at");