# An Outbound Traffic Dashboard for use with Ubuntu Server 24.04.4 and Cockpit!

*See Cockpit install instructions below.*

<br></br>
## The Need:

  Yes, cockpit allows you to filter its logs and view outbound web-traffic events. However, doing so will give you a veritable ocean of successful hits, many from the same URL or Address. Furthermore, ICMP ping requests are not logged out-of-the box. This is a security threat because hackers use ping commands to perform serveillance and smuggle data out of your network unseen. Not cool. If only there were some way to see that... And anyways, looking at these Network Logs in Cockpit has my eyes hurting. There has to be a better way!

## The Idea:

  What if you could could distill all web traffic down to unique URLs and addresses? Then, instead of reviewing millions of log entries, you would only need to review hundreds or (in my case) scores! The idea is simple: comb through the web-traffic logs and create a data object for each unique IP address. Then, record the oldest timestamp, newest timestamp, and number of times that URL/address shows in your logs. Then display them in a nice, clean table, seamlessly integrated into your Cockpit dashboard, with www3 compliant javascript, well-commented code, and completely bug free!

Now, instead of straining your eyes and scrolling until your index finger goes numb, you will see each unique URL/IP address appear ONLY ONCE onscreen, with oldest and most recent timestamps visible, sortable columns, and selectable time-ranges. And, as if that weren't enough, all rendered in that cooler-than-cool Cockpit "dark mode" styling that makes nerds like me giddy (I think I need to get out more often).

## The Solution:

First, setup your Ubuntu logs to record DNS queries, TCP IP address traffic, and ICMP ping traffic. If you don't know how to do this, see the Ubuntu 24-specific guide below. Once you've done this successfully, you can verify by filtering Cockpit's Logs page for "OUT_" and "Looking up RR". Run some ping commands (8.8.8.8, google.com), try a curl command (curl -I https://9.9.9.9) or two. Wait a few seconds, then refresh. You should see them appear in Cockpit now. This confirms your logs are setup correctly. If not, see the Cockpit filtering tips below. Hint: "alert level" matters!

Next, create a folder in ~/.local/share/cockpit called "traffic-monitor" and copies these files into it. Hard-refresh the Cockpit dashboard (Ctrl+F5). You should see a new tab called "Outbound Traffic". Click and enjoy! 

---

### Ubuntu 24.04.4 Log File Configuration:

Ubuntu 24.04 uses systemd-resolved for DNS handling by default. To log queries persistently:
Edit the systemd-resolved service file to enable debug logging:

``` sudo systemctl edit systemd-resolved```
    
In the editor, add the following under the [Service] section:
      
```[Service]```

```Environment=SYSTEMD_LOG_LEVEL=debug```

Make sure you un-comment the [Service] section! Save and exit.
     
Reload and restart the service:
    
``` sudo systemctl daemon-reload```

``` sudo systemctl restart systemd-resolved```


### Supplement with Iptables for IP/Port Logging: 

If you want to log actual outbound connections to HTTP/HTTPS ports (80/443) for IPs (not domains), add iptables rules. This logs to the kernel ring buffer, visible in journalctl or Cockpit logs.

Install iptables-persistent if you want rules to survive reboots:
      
``` sudo apt install iptables-persistent```
      
Add logging rules:
    
``` sudo iptables -A OUTPUT -p tcp --dport 80 -j LOG --log-prefix "OUT_HTTP: "```

``` sudo iptables -A OUTPUT -p tcp --dport 443 -j LOG --log-prefix "OUT_HTTPS: "```

``` sudo netfilter-persistent save```

To view these changes in Cockpit's Logs (search for "OUT_HTTP" or "OUT_HTTPS") 

This setup is minimal, uses only official Ubuntu tools/packages, and avoids complex setups like proxies or third-party software. If your server has heavy traffic, monitor log size (journalctl rotates automatically). For automation/alerts on unauthorized     domains, you could script journalctl output, but that's beyond "simple."


### To Log Ping Traffic:

To log outbound ICMP (ping) traffic with a clear prefix in Cockpit, you can add this rule:

``` sudo iptables -A OUTPUT -p icmp --icmp-type echo-request -j LOG --log-prefix "OUT_PING: "```

``` sudo netfilter-persistent save```


By adding this, you'll have a more complete picture of your server's outbound "pulse" alongside your existing web traffic logs.


### Cockpit Install Instructions:

Cockpit is a lightweight, web-based admin interface available in Ubuntu's repositories. It provides a dashboard for logs, system overview, and more.

To Install Cockpit:
    
``` sudo apt update```

``` sudo apt install cockpit```
      
Enable and start the Cockpit service:
    
``` sudo systemctl enable --now cockpit.socket```
      
Access the dashboard:
    
  ◦ From another machine on your network, open a browser and go to https://your-server-ip:9090 (accept the self-signed certificate warning).
        
  ◦ Log in with your Ubuntu server's username and password (must have sudo privileges for full access).


### How to Filter by Prefix in Cockpit:

To distinguish your logs, go to Network -> View All Logs and use the search box with the following syntax:

  • To see only Pings: Type OUT_PING: in the search box.
    
  • To see only Web Traffic: Type OUT_HTTP: or OUT_HTTPS:.
    
  • To see all your custom firewall logs: Type OUT_. 

      
### Advanced Cockpit Log-Filtering Tips:

Cockpit's log viewer supports more than just simple text searching: 

  • Case Sensitivity: If your search term is all lowercase, it is case-insensitive. If it contains uppercase letters (like OUT_), it becomes case-sensitive by default.
    
  • Priority Filtering: Click the Priority dropdown (or "Severity") to filter for Warning or Info messages. If you used the default iptables log level, they will appear under Warning [User Query].
    
  • Identifier Filter: You can specifically filter for logs generated by the kernel by selecting kernel from the Identifier (or "Service") dropdown.
    
  • Persistence: Once you have a filter active, the URL in your browser updates. You can bookmark that specific search (e.g., .../logs.html#?grep=OUT_PING) to jump straight to your ping logs in the future. 
