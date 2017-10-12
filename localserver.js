#!/usr/bin/env node

var http = require("http");

var fs = require("fs");
var child_process = require("child_process");
var settings = JSON.parse( fs.readFileSync("settings.json", "utf8") );

/*
 *  Write a wpa_supplicant configuration file given a payload string
 *  containing an SSID and an optional password (WPA-PSK).
 */
var applyWiFiConfiguration  = function( payload ) {
  //  (1) Parse the payload into a JSON object.
  config = JSON.parse(payload);

  //  (2) Generate the wpa_supplicant file content.
  var wifi_config = 'ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev\nupdate_config=1\n\nnetwork={\n\t';
  if (config.password) {
    wifi_config += 'ssid="'+config.ssid+'"\n\tpsk="'+config.password+'"\n\tkey_mgmt=WPA-PSK';
  } else {
    wifi_config += 'ssid="'+config.ssid+'"\n\tkey_mgmt=NONE';
  }
  wifi_config += '\n}\n';

  //  (3) Write the file content to disk.
  fs.writeFileSync("config/credentials.conf", wifi_config);
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
        applyWiFiConfiguration( payload );
        console.log("[SoftAP]:\tWiFi Configuration: "+payload);
        console.log("[SoftAP]:\tTerminating SETUP");
        waitForCurrentProcess('setup_3');
      });
      //res.writeHead(200, {'Content-Type': 'text/html'});
      res.end('Configuration parameters received.');
      break;

    default:
      res.end("[SoftAP]:\tHTTP server received unrecognized command: "+req.url);
      break;
  }

});

server.listen(settings.server.port, "172.20.10.11");