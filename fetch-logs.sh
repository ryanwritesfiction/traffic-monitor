#!/bin/bash
# =============================================================================
# fetch-logs.sh - Outbound Traffic Log Collector
# =============================================================================
#
# This script queries the system journal for outbound traffic data from two
# sources: DNS queries (systemd-resolved) and firewall logs (iptables).
#
# It outputs a simple pipe-delimited format that the JavaScript frontend can
# parse quickly, offloading the heavy filtering work to shell tools which are
# much faster than JavaScript for processing 60K+ log lines.
#
# Performance note: We use journalctl's built-in --grep flag to filter at the
# journal level (before data leaves journalctl), which is significantly faster
# than piping all logs through external grep. We also combine all iptables
# queries into a single journalctl call (2 total calls instead of 4).
#
# Usage:
#   ./fetch-logs.sh "24 hours ago"
#   ./fetch-logs.sh "1 week ago"
#   ./fetch-logs.sh "1 month ago"
#   ./fetch-logs.sh "1 year ago"
#
# Output format (one line per log entry):
#   DNS|<timestamp>|<domain>|<query_type>
#   HTTPS|<timestamp>|<dest_ip>
#   HTTP|<timestamp>|<dest_ip>
#   PING|<timestamp>|<dest_ip>
#
# =============================================================================

# The time range argument controls how far back we look in the journal.
# Default to "24 hours ago" if no argument is provided.
TIME_RANGE="${1:-24 hours ago}"

# -----------------------------------------------------------------------------
# 1. DNS Queries from systemd-resolved
# -----------------------------------------------------------------------------
# systemd-resolved logs DNS lookups with the pattern "Looking up RR for".
# We filter by the systemd-resolved unit and use --grep for fast journal-level
# filtering. Then sed extracts the domain name and query type.
#
# Example input:
#   Feb 14 15:54:10 server-clawdbot systemd-resolved[743]: Looking up RR for github.com IN A.
# Example output:
#   DNS|Feb 14 15:54:10|github.com|A

journalctl -u systemd-resolved --since "$TIME_RANGE" --no-pager \
    --grep="Looking up RR for" 2>/dev/null \
    | sed -E 's/^(.{15}) [^ ]+ [^ ]+: Looking up RR for ([^ ]+) IN ([A-Z]+)\..*$/DNS|\1|\2|\3/' \
    | grep "^DNS|"

# -----------------------------------------------------------------------------
# 2. Firewall Traffic (HTTPS, HTTP, PING) from iptables - single query
# -----------------------------------------------------------------------------
# All iptables log entries come from the kernel and have prefixes like
# OUT_HTTPS:, OUT_HTTP:, or OUT_PING:. We fetch them all in one journalctl
# call using a regex, then use sed to classify and extract the destination IP.
#
# Example input (HTTPS):
#   Feb 14 15:55:50 server-clawdbot kernel: OUT_HTTPS: IN= OUT=wlp1s0
#     SRC=192.168.132.180 DST=160.79.104.10 LEN=52 ...
# Example output:
#   HTTPS|Feb 14 15:55:50|160.79.104.10

journalctl --since "$TIME_RANGE" --no-pager \
    --grep="OUT_HTTPS:|OUT_HTTP:|OUT_PING:" 2>/dev/null \
    | sed -E '
        # For each line, try to match one of the three traffic types and
        # extract the timestamp (first 15 chars) and the DST= IP address.

        # HTTPS traffic (port 443) - must be checked before HTTP
        /OUT_HTTPS:/ {
            s/^(.{15}) .* DST=([0-9.]+) .*/HTTPS|\1|\2/
            b done
        }

        # HTTP traffic (port 80)
        /OUT_HTTP:/ {
            s/^(.{15}) .* DST=([0-9.]+) .*/HTTP|\1|\2/
            b done
        }

        # ICMP/Ping traffic
        /OUT_PING:/ {
            s/^(.{15}) .* DST=([0-9.]+) .*/PING|\1|\2/
            b done
        }

        # If none matched, delete the line
        d

        :done
    ' \
    | grep -E "^(HTTPS|HTTP|PING)\|"
