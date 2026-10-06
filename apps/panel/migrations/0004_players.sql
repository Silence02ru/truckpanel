CREATE TABLE "server_players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"client_id" integer,
	"steam_id64" text,
	"connected" boolean DEFAULT false NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"sessions" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "game_version" text;--> statement-breakpoint
ALTER TABLE "server_players" ADD CONSTRAINT "server_players_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "server_players_name_uq" ON "server_players" USING btree ("server_id","name");--> statement-breakpoint
CREATE INDEX "server_players_connected_idx" ON "server_players" USING btree ("server_id","connected");