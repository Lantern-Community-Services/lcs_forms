<?php
/**
 * Plugin Name: Lantern Roster Connector
 * Description: Fills Gravity Forms resident fields from Lantern Roster and reports form activity back, so the 48-hour review queue knows who is still around.
 * Version:     0.1.1
 * Author:      Lantern Community Services
 *
 * ── Setup ────────────────────────────────────────────────────────────────
 * wp-config.php:
 *   define('LANTERN_ROSTER_API', 'https://roster.lanterncommunity.org/api/v1');
 *   define('LANTERN_ROSTER_KEY', 'lrk_…');                 // roster:read + activity:write
 *   define('LANTERN_ROSTER_WEBHOOK_SECRET', 'whsec_…');    // optional, for instant cache refresh
 *
 * In a form, give a Drop Down / Checkboxes / Multi Select / Radio field the CSS classes:
 *   lantern-roster lantern-site-<site code>          e.g. "lantern-roster lantern-site-amber-hall"
 * or "lantern-roster lantern-site-param" to take the site from ?site=<code> in the page URL.
 * lantern-site-param works only for signed-in WordPress users who can edit_posts (the
 * same as the shortcode; change it with the lantern_roster_site_param_capability filter):
 * anyone else could change ?site= to list any site's residents. Public forms use a fixed
 * lantern-site-<code> class.
 *
 * The field's stored value is the permanent roster ID. After submission the
 * connector POSTs those IDs to /activity, which resets each person's review clock.
 *
 * Shortcode for staff pages (logged-in users with edit_posts by default):
 *   [lantern_roster site="amber-hall"]
 */

if (!defined('ABSPATH')) exit;

const LANTERN_ROSTER_CACHE_TTL = 300; // seconds; webhooks clear it sooner

function lantern_roster_configured(): bool {
    return defined('LANTERN_ROSTER_API') && defined('LANTERN_ROSTER_KEY') && LANTERN_ROSTER_API && LANTERN_ROSTER_KEY;
}

function lantern_roster_request(string $method, string $path, ?array $body = null) {
    if (!lantern_roster_configured()) return new WP_Error('lantern_roster', 'Lantern Roster is not configured in wp-config.php.');
    $args = [
        'method'  => $method,
        'timeout' => 5,
        'headers' => ['Authorization' => 'Bearer ' . LANTERN_ROSTER_KEY, 'Accept' => 'application/json'],
    ];
    if ($body !== null) {
        $args['headers']['Content-Type'] = 'application/json';
        $args['body'] = wp_json_encode($body);
    }
    $res = wp_remote_request(rtrim(LANTERN_ROSTER_API, '/') . $path, $args);
    if (is_wp_error($res)) return $res;
    $code = wp_remote_retrieve_response_code($res);
    $json = json_decode(wp_remote_retrieve_body($res), true);
    if ($code >= 400 && $code !== 422) {
        return new WP_Error('lantern_roster', is_array($json) && isset($json['error']) ? $json['error'] : "HTTP $code");
    }
    return ['status' => $code, 'body' => $json];
}

// ── Roster choices (cached) ──────────────────────────────────────────────

function lantern_roster_choices(string $site): array {
    $site = sanitize_key($site);
    if ($site === '') return [];
    $key = 'lantern_roster_choices_' . $site;
    $cached = get_transient($key);
    if (is_array($cached)) return $cached;

    $res = lantern_roster_request('GET', '/sites/' . rawurlencode($site) . '/choices');
    if (is_wp_error($res) || !is_array($res['body'])) {
        error_log('[lantern-roster] choices for ' . $site . ' failed: ' . (is_wp_error($res) ? $res->get_error_message() : 'bad body'));
        // Serve the last good copy rather than an empty dropdown.
        $stale = get_option($key . '_last', []);
        return is_array($stale) ? $stale : [];
    }
    set_transient($key, $res['body'], LANTERN_ROSTER_CACHE_TTL);
    update_option($key . '_last', $res['body'], false);
    $known = get_option('lantern_roster_sites', []);
    if (!in_array($site, $known, true)) update_option('lantern_roster_sites', array_merge($known, [$site]), false);
    return $res['body'];
}

function lantern_roster_flush_cache(): void {
    foreach ((array) get_option('lantern_roster_sites', []) as $site) delete_transient('lantern_roster_choices_' . $site);
}

/** Site code from the field's CSS classes, or null when this isn't a roster field. */
function lantern_roster_field_site($field): ?string {
    $classes = preg_split('/\s+/', (string) ($field->cssClass ?? ''));
    if (!in_array('lantern-roster', $classes, true)) return null;
    foreach ($classes as $c) {
        if ($c === 'lantern-site-param') {
            // The visitor picks the site here, so only staff may: residents' names are never shown to the public.
            $cap = (string) apply_filters('lantern_roster_site_param_capability', 'edit_posts');
            if (!is_user_logged_in() || !current_user_can($cap)) return '';
            return isset($_GET['site']) ? sanitize_key(wp_unslash($_GET['site'])) : '';
        }
        if (strpos($c, 'lantern-site-') === 0) return substr($c, strlen('lantern-site-'));
    }
    return '';
}

function lantern_roster_populate($form) {
    if (!is_array($form) || empty($form['fields'])) return $form;
    foreach ($form['fields'] as &$field) {
        $site = lantern_roster_field_site($field);
        if ($site === null) continue;
        $choices = $site === '' ? [] : lantern_roster_choices($site);
        $field->choices = $choices ?: [['text' => $site === '' ? 'No site selected' : 'Roster unavailable — try again shortly', 'value' => '']];
        if ($field->type === 'checkbox') {
            // Checkbox inputs must line up 1:1 with choices; GF skips input ids ending in 0.
            $inputs = [];
            $n = 1;
            foreach ($field->choices as $choice) {
                if ($n % 10 === 0) $n++;
                $inputs[] = ['id' => $field->id . '.' . $n, 'label' => $choice['text'], 'name' => ''];
                $n++;
            }
            $field->inputs = $inputs;
        }
        if ($field->type === 'select' && empty($field->placeholder)) $field->placeholder = 'Choose a resident';
    }
    return $form;
}
foreach (['gform_pre_render', 'gform_pre_validation', 'gform_pre_submission_filter', 'gform_admin_pre_render'] as $hook) {
    add_filter($hook, 'lantern_roster_populate');
}

// ── Report activity after submission ─────────────────────────────────────

function lantern_roster_selected_ids($field, array $entry): array {
    $ids = [];
    if ($field->type === 'checkbox' && is_array($field->inputs)) {
        foreach ($field->inputs as $input) {
            $v = rgar($entry, (string) $input['id']);
            if ($v !== '' && $v !== null) $ids[] = $v;
        }
    } elseif ($field->type === 'multiselect') {
        $raw = rgar($entry, (string) $field->id);
        $decoded = json_decode((string) $raw, true);
        $ids = is_array($decoded) ? $decoded : array_filter(explode(',', (string) $raw));
    } else {
        $v = rgar($entry, (string) $field->id);
        if ($v !== '' && $v !== null) $ids[] = $v;
    }
    return array_values(array_unique(array_map('strval', $ids)));
}

add_action('gform_after_submission', function ($entry, $form) {
    $ids = [];
    foreach ($form['fields'] as $field) {
        $site = lantern_roster_field_site($field);
        if ($site === null || $site === '') continue;
        // Only residents the field offered (its site's roster): a posted value can be anything.
        $offered = array_map('strval', wp_list_pluck(lantern_roster_choices($site), 'value'));
        $ids = array_merge($ids, array_values(array_intersect(lantern_roster_selected_ids($field, $entry), $offered)));
    }
    $ids = array_values(array_unique(array_filter($ids)));
    if (!$ids) return;

    $payload = [
        'source'      => 'gravity_forms',
        'label'       => sprintf('%s (form %d)', $form['title'], $form['id']),
        // Idempotency key: a resubmitted/retried webhook for this entry counts once.
        'externalRef' => sprintf('gf-%d-%d', $form['id'], $entry['id']),
        // GF stores date_created in UTC.
        'occurredAt'  => gmdate('Y-m-d\TH:i:s\Z', strtotime($entry['date_created'] . ' UTC')),
        'tenantIds'   => $ids,
    ];
    $res = lantern_roster_request('POST', '/activity', $payload);
    if (is_wp_error($res)) {
        error_log('[lantern-roster] activity post failed, queued for retry: ' . $res->get_error_message());
        $queue = (array) get_option('lantern_roster_retry', []);
        $queue[] = $payload;
        update_option('lantern_roster_retry', array_slice($queue, -500), false);
    }
}, 10, 2);

// Retry anything that failed (roster API down, network blip). Hourly.
add_action('lantern_roster_retry', function () {
    $queue = (array) get_option('lantern_roster_retry', []);
    if (!$queue) return;
    $left = [];
    foreach ($queue as $payload) {
        $res = lantern_roster_request('POST', '/activity', $payload);
        if (is_wp_error($res)) $left[] = $payload;
    }
    update_option('lantern_roster_retry', $left, false);
});
add_action('init', function () {
    if (!wp_next_scheduled('lantern_roster_retry')) wp_schedule_event(time() + 300, 'hourly', 'lantern_roster_retry');
});

// ── Webhook receiver: roster changed → refresh dropdowns now ─────────────

add_action('rest_api_init', function () {
    register_rest_route('lantern-roster/v1', '/webhook', [
        'methods'             => 'POST',
        'permission_callback' => '__return_true', // authenticated by HMAC below
        'callback'            => function (WP_REST_Request $req) {
            if (!defined('LANTERN_ROSTER_WEBHOOK_SECRET') || !LANTERN_ROSTER_WEBHOOK_SECRET) {
                return new WP_REST_Response(['error' => 'webhook secret not configured'], 503);
            }
            $raw = $req->get_body();
            $expected = 'sha256=' . hash_hmac('sha256', $raw, LANTERN_ROSTER_WEBHOOK_SECRET);
            $given = (string) $req->get_header('x-lantern-signature');
            if (!hash_equals($expected, $given)) return new WP_REST_Response(['error' => 'bad signature'], 401);

            $event = json_decode($raw, true);
            if (isset($event['event']) && (strpos($event['event'], 'tenant.') === 0 || $event['event'] === 'webhook.test')) {
                lantern_roster_flush_cache();
                do_action('lantern_roster_event', $event); // hook for anything else that cares
            }
            return new WP_REST_Response(['ok' => true], 200);
        },
    ]);
});

// ── [lantern_roster site="…"] for staff pages ────────────────────────────

add_shortcode('lantern_roster', function ($atts) {
    $atts = shortcode_atts(['site' => ''], $atts, 'lantern_roster');
    // Resident names are personal data — never render them to the public.
    $cap = apply_filters('lantern_roster_shortcode_capability', 'edit_posts');
    if (!is_user_logged_in() || !current_user_can($cap)) return '';
    $res = lantern_roster_request('GET', '/sites/' . rawurlencode(sanitize_key($atts['site'])) . '/roster');
    if (is_wp_error($res) || empty($res['body']['items'])) return '<p>Roster unavailable.</p>';
    $out = '<table class="lantern-roster"><thead><tr><th>Unit</th><th>Name</th></tr></thead><tbody>';
    foreach ($res['body']['items'] as $t) {
        $out .= '<tr><td>' . esc_html($t['unit'] ?? '') . '</td><td>' . esc_html($t['displayName']) . '</td></tr>';
    }
    return $out . '</tbody></table>';
});
