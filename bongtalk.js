"use strict";
/**
 * Module dependencies.
 */

var routes = require('./routes');
var user = require('./routes/user');
var express = require('express');
var http = require('http');
var path = require('path');
var util = require('util');

exports.BongTalk = (function () {
    function BongTalk(servicePort) {
        this.servicePort = servicePort;
    }

    BongTalk.prototype.start = function () {
        var app = express();

// all environments
        app.set('port', process.env.PORT || this.servicePort);
        app.set('views', path.join(__dirname, 'views'));
        app.set('view engine', 'jade');
        app.use(express.favicon());
        app.use(express.logger('dev'));
        app.use(express.json());
        app.use(express.urlencoded());
        app.use(express.methodOverride());
        app.use(app.router);
        app.use(express.static(path.join(__dirname, 'public')));

// development only
        if ('development' === app.get('env')) {
            app.use(express.errorHandler());
        }

        app.get('/', routes.index);
        app.get('/users', user.list);

        var server = http.createServer(app);

        var io = require('socket.io').listen(server);

        server.listen(app.get('port'), function () {
            util.log('Express server listening on port ' + app.get('port'));
        });

        var models = require('./models');
        var User = models.User;
        var Zones = models.Zones;

        /**
         * Global variables
         */
        var zones = new Zones();

        io.sockets.on('connection', function (socket) {
            //create user
            var user = new User(socket, socket.id);

            //sendProfile
            socket.emit('sendProfile', user.getSimpleUser());

            socket.on('joinZone', function(data) {
                user.name = data.user.name;
                zones.getZone(data.zoneId).join(user);
            });

            socket.on('sendMessage', function(data){
                if (user.currentZone) {
                    user.currentZone.broadcastTalk(user, data);
                }
            });

            socket.on('changeName', function(data){
                user.changeName(data);
            });

            socket.on('disconnect', function(){
                util.log(" Peer " + user.name + " disconnected.");
                if (user.currentZone) {
                    user.currentZone.leave(user);
                }
            });
        });
    };

    return BongTalk;
})();





