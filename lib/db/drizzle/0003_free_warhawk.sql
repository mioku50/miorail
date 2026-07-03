CREATE TABLE IF NOT EXISTS "provider_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"chain_id" integer NOT NULL,
	"payload" jsonb,
	"status" text NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
