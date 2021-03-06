#!/usr/bin/env node

var http = require("http");

var fs = require("fs");
var child_process = require("child_process");
var settings = JSON.parse( fs.readFileSync("settings.json", "utf8") );

var events = require("events");
var exec = child_process.exec;
var eventEmitter = new events.EventEmitter();
var psTree = require('ps-tree');

var Tail = require("tail").Tail;
var wpaTail = new Tail("config/wpa_log");
wpaTail.unwatch();




/*
 *  Write a wpa_supplicant configuration file given a payload string
 *  containing an SSID and an optional password (WPA-PSK).
 */
var applyWiFiConfiguration  = function( payload ) {
  //  (1) Parse the payload into a JSON object.
  config = JSON.parse(payload);
  console.log("Config Payload!");
  console.log(config);

  //  (2) Generate the wpa_supplicant file content.
   var wifi_config = 'ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev\nupdate_config=1\n\nnetwork={\n\tssid="iPhone"\n\tpsk="1234babylon"\n\tkey_mgmt=WPA-PSK\n\tpriority=8\n}\n';
  wifi_config += '\nnetwork={\n\t';
  if (config.password) {
    wifi_config += 'ssid="'+config.ssid+'"\n\tpsk="'+config.password+'"\n\tkey_mgmt=WPA-PSK';
  } else {
    wifi_config += 'ssid="'+config.ssid+'"\n\tkey_mgmt=NONE';
  }
  wifi_config += '\n\tpriority=2';
  wifi_config += '\n}\n';

  //  (3) Write the file content to disk.
  console.log("Appending config to wifi wpa_supplicant");
  //fs.appendFileSync("/etc/wpa_supplicant/wpa_supplicant.conf", wifi_config);
  fs.writeFileSync("/etc/wpa_supplicant/wpa_supplicant.conf",wifi_config);
};


/*
 *  Return a JSON list of nearby WiFi access points.
 */
var getScanResults = function() {
  /*
   * (1)  Get raw scan results.
   */
  console.log("Scanning WiFi...");
  var scanByLines = child_process.execSync("sudo iw dev wlan0 scan ap-force").toString().split("\n");
  /*
   *  (2) Initialize empty array, empty first record object
   */
  var scanResults = [];
  var scanResult = {
    ssid: null,
    security: false,
    signal: null
  };
  /*
   *  (3) Parse raw scan results line by line.
   */
  console.log("Parsing WiFi scan results...");
  for (l=0; l<scanByLines.length; l++) {
    var line = scanByLines[l].trim(); // remove any trailing white space

    if ( iwlist_parse.new_cell.test(line) ) {
      // This is a new cell, reset the current scan result object.
      scanResult = {
        ssid: null,
        security: false,
        signal: null
      };
      continue;
    }

    var ssid_parse = iwlist_parse.ssid.exec(line);
    if ( ssid_parse ) {
      scanResult.ssid = ssid_parse[1];
      // This is the last line of the current cell!
      if (scanResult.ssid.length) {
        scanResults.push( scanResult );
      }
      continue;
    }

    if ( iwlist_parse.encryption.test(line) ) {
        scanResult.security = true;
    }

    var signal_parse = iwlist_parse.signal.exec(line);
    if ( signal_parse ) {
      scanResult.signal = parseInt( signal_parse[1] );
    }
  }
  console.log(scanResults.length + " nearby SSIDs found.");
  console.log(scanResults);
  return scanResults;
};


//  Regex Rules for Parsing iwlist results
var iwlist_parse = {
  new_cell: new RegExp(/.*BSS [0-9a-z]{2}:.*/),
  ssid: new RegExp(/.*SSID: (.*).*/),
  encryption: new RegExp(/.*Privacy.*/),
  signal: new RegExp(/.*signal: (-[0-9\.]+).*/)
};

/*
 *  Create an HTTP server that listens for new WiFi credentials
 *  and also provides lists of nearby WiFi access points.
 */
server = http.createServer( function(req, res) {
  //  (1) We don't know what IP the clients may have during setup!
  res.writeHead(200, {'Access-Control-Allow-Origin': '*'});

  var attemptConnection = false
  switch (req.url) {
  	case "/jquery":
  		fs.readFile('jquery-3.2.1.min.js',function(err,data) {
  			res.writeHead(200, {'Content-Type': 'text/javascript'});
        res.write(data);
        res.end();
  		});
  		break;
    
    case "/portal":
        fs.readFile('user-portal.html', function(err, data) {
          res.writeHead(200, {'Content-Type': 'text/html'});
          res.write(data);
          res.end();
		    });
        break;
    case "/scan":
      console.log("WiFi Scan requested...");
      res.writeHead(200, {'Content-Type': 'text/json'});
      res.end( JSON.stringify( getScanResults() ) );
      break;

    case "/configure":
      var payload = '';
      req.on('data', function(data) {
        payload += data;
      });
      req.on('end', function() {
        console.log(payload);
        console.log("Before payload processing");
        applyWiFiConfiguration( payload );
        console.log("[SoftAP]:\tWiFi Configuration: "+payload);
        console.log("[SoftAP]:\tTerminating SETUP");
        // waitForCurrentProcess('setup_3');
      });
      //res.writeHead(200, {'Content-Type': 'text/html'});
      res.end('Configuration parameters received.');
      break;

    default:
      res.end("[SoftAP]:\tHTTP server received unrecognized command: "+req.url);
      break;
  }

});

/*
 *  Write a hostapd configuration file based on the parameters contained
 *  in the settings object.
 */
var configureHostapd = function() {
  var hostapd_config = 'interface=wlan0\n';
  hostapd_config += 'driver=nl80211\n';
  hostapd_config += 'ssid=' + (settings.server.ssid || "RPi SoftAP") + '\n';
  hostapd_config += 'hw_mode=g\n';
  hostapd_config += 'channel=' + String(settings.server.channel || 9) + '\n';
  hostapd_config += 'macaddr_acl=0\n';
  hostapd_config += 'ignore_broadcast_ssid=0\n';
  hostapd_config += 'wmm_enabled=0';
  fs.writeFileSync("config/hostapd.conf", hostapd_config);
};

/*
 *  Track & kill child processes
 */
current_proc = null;
kill_requested = false;
/*
 *  Kill the currently running process, if any, as well as any
 *  children it may have spawned.
 */
var killCurrentProcess = function() {
  if (!current_proc) return;
  kill_requested = true;
  psTree( current_proc.pid, function(err, children) {
      child_process.spawnSync('kill', ['-2'].concat(children.map(function(p) {return p.PID})));
  });
};

/*
 *  execStepCommand will asnychronously issue a system command, and
 *  optionally emit a specified nextStep -- but ONLY if the command
 *  is not killed by killCurrentProcess being called.  This allows
 *  command chains to be cleanly broken before issuing a new next step
 *  via waitForCurrentProcess(nextStep).
 */
var execStepCommand = function(command, nextStep) {
  current_proc = exec(command, function(err, stdout, stderr) {
    console.log(command, " is killed, kill_requested: ", kill_requested);
    current_proc = null;
    if ( kill_requested ) {
      kill_requested = false;
      return;
    } else {
      kill_requested = false;
      if ( nextStep ) {
        eventEmitter.emit( nextStep );
      }
    }
  });
};

/*
 *  This method will defer the emission of a specified nextStep until
 *  the kill_requested flag has been neutralized, indicating that any
 *  outstanding process has terminated.
 */
curr_proc_timer = null;
var waitForCurrentProcess = function(nextStep) {
  curr_proc_timer = setInterval( function() {
    console.log(nextStep, " is waiting...");
    if ( !kill_requested ) {
      clearInterval( curr_proc_timer );
      eventEmitter.emit( nextStep );
    }
  }, 50);
}



  'use strict';
  var os = require('os');
  var ifaces = os.networkInterfaces();

function getCurrentIPAddress() {



}

/*
 *  Register SETUP commands.
 */
// // (0) Pre-Setup
// eventEmitter.on('pre-setup', function() {
//   // eventEmitter.emit("neo", "spin", rgb2Int(70, 200, 200), {period: 1500, tracelength: settings.neopixels.size*0.75});
//   console.log("[SoftAP]:\tExecuting pre-setup command...");
//   if (settings.actions.preSetup) {
//     execStepCommand(settings.actions.preSetup, "setup_1");
//   } else {
//     eventEmitter.emit("setup_1");
//   }
// });

// // (1) Start SoftAP Beacon
// eventEmitter.on('setup_1', function() {
//   // eventEmitter.emit("neo", "spin", rgb2Int(255, 180, 0), {period: 1500, tracelength: settings.neopixels.size*0.75});
//   console.log("[SoftAP]:\tInitializing access point...");
//   wpaTail.unwatch();
//   configureHostapd();
//   execStepCommand("sudo bash scripts/beacon_up", "setup_2");
// });

// // (2) Start SoftAP Server
// eventEmitter.on('setup_2', function() {
//   server.listen(settings.server.port, "192.168.42.1");
//   // eventEmitter.emit("neo", "breathe", rgb2Int(0, 0, 255));
//   console.log('[SoftAP]:\tServer listening at http://192.168.42.1:'+settings.server.port+'.');
//   // Note: The server will call setup_3 when the user has completed configuration.
// });

// // (3) Stop the SoftAP Server
// eventEmitter.on('setup_3', function() {
//   // eventEmitter.emit("neo", "spin", rgb2Int(255, 180, 0), {period: 2000, tracelength: settings.neopixels.size*0.75});
//   console.log("[SoftAP]:\tServer is now terminating.");
//   server.close();
//   waitForCurrentProcess('setup_4');
// });

// // (4) Stop the SoftAP beacon
// eventEmitter.on('setup_4', function() {
//   console.log("[SoftAP]:\tTerminating access point...");
//   execStepCommand("sudo bash scripts/beacon_down", 'connect_1');
// });


// /*
//  *  Register CONNECT commands.
//  */
// eventEmitter.on('connect_1', function() {
//   // eventEmitter.emit("neo", "spin", rgb2Int(255, 255, 0), {period: 5000, tracelength: settings.neopixels.size*0.75});
//   console.log("[SoftAP]:\tTearing down any pre-existing WiFi daemon...");
//   execStepCommand('sudo systemctl stop wpa-keepalive.service', 'connect_2');//"sudo wpa_cli -i wlan0 terminate", 'connect_2');
// });

// watchingWPA = false;
// function watchWPA( watch ) {
//   watchingWPA = watch;
//   if (watch) {
//     wpaTail.watch();
//   } else {
//     wpaTail.unwatch();
//   }
// }

// eventEmitter.on('connect_2', function() {
//   // eventEmitter.emit("neo", "spin", rgb2Int(0, 255, 255), {period: 4000, tracelength: settings.neopixels.size*0.75});
//   console.log("[SoftAP]:\tInvoking WiFi daemon...");
//   watchWPA( true );
//   execStepCommand('sudo systemctl start wpa-keepalive.service'); //"sudo wpa_supplicant -B -P /run/wpa_supplicant.wlan0.pid -i wlan0 -D nl80211,wext -c config/credentials.conf -f config/wpa_log");
// });

// wpaTail.on('line', function(line) {
//   if (!watchingWPA) {
//     console.log("Not watching wpa");
//     return;
//   }
//   if (line.indexOf("wlan0: CTRL-EVENT-CONNECTED") > -1) {
//     // The WiFi information was valid and we are associated!
//     console.log("[SoftAP]:\tSuccessfully associated with WiFi AP.");
//     //current_proc.stdout.removeListener('data', parseWpaStdout);
//     watchWPA( false );
//     waitForCurrentProcess('connect_3');
//   } else if (line.indexOf("wlan0: WPA: 4-Way Handshake failed - pre-shared key may be incorrect") > -1) {
//     // The provided password is incorrect
//     console.log("[SoftAP]:\tThe provided WiFi credentials don't seem to be valid; probably an incorrect password.");
//     //current_proc.stdout.removeListener('data', parseWpaStdout);
//     watchWPA( false );
//     killCurrentProcess();
//     eventEmitter.emit('failure_incorrect_passphrase');
//   } else if (line.indexOf("wlan0: No suitable network found") > -1) {
//     console.log("[SoftAP]:\tThe WiFi network is not within range!");
//     eventEmitter.emit('failure_ssid_not_found');
//   } else if (line.indexOf("Invalid passphrase") > -1) {
//     console.log("[SoftAP]:\tThe provided WiFi passphrase is invalid (incorrect length).");
//     //current_proc.stdout.removeListener('data', parseWpaStdout);
//     watchWPA( false );
//     killCurrentProcess();
//     eventEmitter.emit('failure_incorrect_passphrase');
//   }
// });

// eventEmitter.on('connect_3', function() {
//   // eventEmitter.emit("neo", "spin", rgb2Int(0, 255, 150), {period: 2000, tracelength: settings.neopixels.size*0.75});
//   console.log("[SoftAP]:\tFlushing IP address...");
//   execStepCommand("sudo ip addr flush dev wlan0", 'connect_4');
// });

// eventEmitter.on('connect_4', function() {
//   // eventEmitter.emit("neo", "spin", rgb2Int(0, 255, 150), {period: 1000, tracelength: settings.neopixels.size*0.75});
//   console.log("[SoftAP]:\tAcquiring IP address...");
//   execStepCommand("sudo dhclient wlan0", 'connect_done');
// });

// eventEmitter.on('connect_done', function() {
//   console.log('[SoftAP]:\tWiFi connection complete.');
//   // eventEmitter.emit("neo", "breathe", rgb2Int(0, 255, 0));
//   if ( settings.actions.whenOnline ) {
//     console.log("[SoftAP]:\tExecuting post-connection command...");
//     execStepCommand( settings.actions.whenOnline );
//   }
// });

// /*
//  *  Connection Failure Events
//  */
// eventEmitter.on('failure_incorrect_passphrase', function() {
//   // eventEmitter.emit("neo", "breathe", rgb2Int(255, 0, 0));
//   console.log("[SoftAP]:\t FAILURE INCORRECT PASSPHRASE");
// });

// eventEmitter.on('failure_ssid_not_found', function() {
//   // eventEmitter.emit("neo", "spin", rgb2Int(255, 255, 0), {period: 2000, tracelength: settings.neopixels.size*0.75});
//   console.log("[SoftAP]:\t FAILURE SSID NOT FOUND");
// });

// // Use either current internet IP address or SoftAP constant 192.168.42.1


  var ipaddr = 0;

  Object.keys(ifaces).forEach(function (ifname) {
    var alias = 0;


    ifaces[ifname].forEach(function (iface) {
      if ('IPv4' !== iface.family || iface.internal !== false) {
        // skip over internal (i.e. 127.0.0.1) and non-ipv4 addresses
        return;
      }

      // if (alias >= 1) {
      //   // this single interface has multiple ipv4 addresses
      //   console.log(ifname + ':' + alias, iface.address);
      //   // return iface.address
      // } 
      // else {
        // this interface has only one ipv4 adress
        console.log(ifname, iface.address);
        server.listen(settings.server.port, iface.address);
       
        // console.log("Current iP " + ipaddr);
        // return iface.address
      // }
      ++alias;
    });
  });


console.log("Found current IP address");


// server.listen(settings.server.port, "172.20.10.11");

// /*
//   *                 >>> Launch <<<
//   */
// child_process.execSync("sudo systemctl start dhcpcd.service");
// fs.access("/etc/wpa_supplicant/wpa_supplicant.conf", fs.F_OK, function(err) {
//   // if (!err) {
//   //   eventEmitter.emit('connect_1');
//   // } else {
//   eventEmitter.emit('pre-setup');
//   // }
// });

// /*
//  *  Trap the SIGINT and do cleanup before closing.
//  */
// process.on('SIGINT', function () {
//   console.log("[SoftAP]:\tSIGINT received.");
//   killCurrentProcess();
//   // neopixels.reset();
//   server.close();
//   console.log("[SoftAP]:\tExiting Node process.");
//   process.exit(0);
// });
