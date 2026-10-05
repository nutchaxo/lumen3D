<?php
/* CLI driver of the PHP migrations engine for the cross-backend tests
   (tests/test_mig_php_parity.py). Not a test itself.
     php tests/mig_php_driver.php <request.json>
   request: { dataWeb, uploads, private, zeroBudgetFloor?, execLimit?, ops: [ {op, …} ] } → prints a JSON list
   (execLimit: max_execution_time as the engine sees it, LUMEN_MIG_EXEC_LIMIT):
     {op:'handle', action, params?, body?, rawFile?}   → [status, payload]
     {op:'unit_tiles', dataset, unit}                  → {z: base64 PNG} (server executor)
     {op:'caps'}                                       → lumen_mig_capabilities()
     {op:'binary', action, params}                     → [status, type, base64 body]
     {op:'unit_result', dataset, migration, unit, part?} → {result: {name: base64}, bytesRead} (server executor, nothing
                                                        stored; part 0..7 = one m004 octant)
     {op:'peak'}                                       → memory_get_peak_usage() so far      */
declare(strict_types=1);

$req = json_decode((string)file_get_contents($argv[1]), true);
define('LUMEN_DATA_WEB', $req['dataWeb']);
define('LUMEN_UPLOADS_DIR', $req['uploads']);
define('LUMEN_PRIVATE_DIR', $req['private']);
if (!empty($req['zeroBudgetFloor'])) define('LUMEN_MIG_BUDGET_FLOOR', 0);
if (isset($req['execLimit'])) define('LUMEN_MIG_EXEC_LIMIT', (int)$req['execLimit']);
@mkdir($req['private'], 0777, true);
require __DIR__ . '/../api/_migrations_lib.php';

$out = [];
foreach ($req['ops'] as $op) {
    switch ($op['op']) {
        case 'handle':
            $raw = isset($op['rawFile']) ? (string)file_get_contents($op['rawFile']) : null;
            $out[] = lumen_mig_handle($op['action'], $op['params'] ?? [], $op['body'] ?? [], $raw);
            break;
        case 'unit_tiles':
            [$tiles, $read] = lumen_mig_process_unit(lumen_mig_plan_for($op['dataset']), lumen_mig_parse_key($op['unit']));
            $enc = [];
            foreach ($tiles as $z => $png) $enc[(string)$z] = base64_encode($png);
            $out[] = ['tiles' => (object)$enc, 'bytesRead' => $read];
            break;
        case 'caps':
            $out[] = lumen_mig_capabilities();
            break;
        case 'binary':
            [$st, $type, $data, $file] = lumen_mig_handle_binary($op['action'], $op['params'] ?? []);
            $out[] = [$st, $type, base64_encode($file !== null ? (string)file_get_contents($file) : (string)$data)];
            break;
        case 'unit_result':
            $plan = lumen_mig_plan_for($op['dataset']);
            $us = lumen_mig_unitset($plan, $op['migration']);
            $unit = lumen_mig_parse_key_for($op['migration'], $op['unit']);
            $store = lumen_mig_store_dir($plan['type'], $plan['folder'], $op['migration']);
            if (isset($op['part'])) [$res, $read] = lumen_mig_process_unit_m004($plan, $us, $unit, $store, (int)$op['part']);
            else [$res, $read] = lumen_mig_process_any($plan, $us, $unit, $op['unit'], $store);
            $enc = [];
            foreach (is_array($res) ? $res : ['tile' => $res] as $k => $v) if ($v !== null) $enc[(string)$k] = base64_encode($v);
            $out[] = ['result' => (object)$enc, 'bytesRead' => $read];
            break;
        case 'peak':
            $out[] = ['peak' => memory_get_peak_usage(), 'limit' => ini_get('memory_limit')];
            break;
        default:
            $out[] = ['error' => 'unknown op'];
    }
}
echo json_encode($out, JSON_UNESCAPED_SLASHES);
