
var mnet_parser = require("./mnet_parser");
var mnet_client = require('./mnet_client');

var diff = require('deep-diff').diff;
var observableDiff = require('deep-diff').observableDiff;

var EventEmitter = require('events').EventEmitter;
var ac_emitter = new EventEmitter();

// G-50A 192.168.1.1 v. 2.60
// http://192.168.1.1/g-50/en/administrator.html
// http://192.168.1.1/g-50/en/head-login.html
// Maintenance user: initial/init
// Building manager: administrator/admin

var mnet_devices = [];
mnet_client.mnet_config.host = "192.168.0.10";
// mnet_client.mnet_config.groupListInterval = 4000;

function group_id_to_name(id) {
    mapping = {
        1: 'Fitness',
        2: 'Living room',
        3: 'Dining room',
        4: 'Wardrobe',
        5: 'Bedroom'
    }
    return mapping[id];
}

function processMessageDevice(group, bulk) {
    parsed = mnet_parser.parse(group, bulk, group_id_to_name);
    if (!parsed.Drive)
        return;
    stored = mnet_devices[group];
    changes = diff(stored, parsed);
    if (changes) {
        mnet_devices[group] = parsed;
        stored = parsed;
        ac_emitter.emit('ac_event', { group: group, newState: parsed, changes: changes });
    } 
}

function processMessage(devicesJson) {
    for (i = 0; i < devicesJson.length; i++) {
        deviceJson = devicesJson[i];
        processMessageDevice(deviceJson.$.Group, deviceJson.$.Bulk);
    }
}

mnet_client.mnet_events.on('bus_event', function (data) {
    devicesJson = data.Packet.DatabaseManager[0].Mnet;
    processMessage(devicesJson);
});

ac_emitter.on('ac_event', function (data) {
    group = data.group;
    newState = data.newState;
    changes = data.changes
    console.log('ac changed Group ' + group + ' (' + newState.GroupName + '): ' + changes[0].path + ' from ' + changes[0].lhs + ' to ' + changes[0].rhs);
});

mnet_client.startMonitoring();

// setInterval(() => {
//     // console.log('powering down');
//     mnet_client.getGroups().forEach(group => {
//         mnet_client.setDrive(group, false);
//     });
//     // console.log('powered down');
// }, 15000);