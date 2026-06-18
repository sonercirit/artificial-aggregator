ALTER TABLE `model_results` ADD `cost_per_task` real;--> statement-breakpoint
ALTER TABLE `model_results` ADD `input_cost_per_task` real;--> statement-breakpoint
ALTER TABLE `model_results` ADD `output_cost_per_task` real;--> statement-breakpoint
ALTER TABLE `model_results` ADD `reasoning_cost_per_task` real;--> statement-breakpoint
ALTER TABLE `model_results` ADD `answer_cost_per_task` real;--> statement-breakpoint
ALTER TABLE `model_results` ADD `time_per_task` real;