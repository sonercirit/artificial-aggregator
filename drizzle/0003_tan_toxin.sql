ALTER TABLE `fetch_runs` ADD `default_winner_model_key` text;--> statement-breakpoint
CREATE INDEX `model_results_unscoreable_cleanup_idx` ON `model_results` (`run_id`,`id`) WHERE COALESCE("model_results"."cost_per_task", "model_results"."total_cost") IS NULL OR COALESCE("model_results"."cost_per_task", "model_results"."total_cost") <= 0 OR "model_results"."intelligence" IS NULL;--> statement-breakpoint
CREATE INDEX `model_results_raw_json_cleanup_idx` ON `model_results` (`run_id`,`id`) WHERE "model_results"."raw_result_json" <> '{}';--> statement-breakpoint
UPDATE `fetch_runs`
SET `default_winner_model_key` = (
  SELECT `mr`.`model_key`
  FROM `model_results` AS `mr`
  WHERE `mr`.`run_id` = `fetch_runs`.`id`
    AND COALESCE(`mr`.`cost_per_task`, `mr`.`total_cost`) > 0
    AND `mr`.`intelligence` IS NOT NULL
  ORDER BY `mr`.`intelligence` DESC, LOWER(`mr`.`name`) ASC, `mr`.`id` ASC
  LIMIT 1
)
WHERE `status` = 'success';