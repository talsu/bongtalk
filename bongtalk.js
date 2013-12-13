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
var redis = require("redis");

var RedisStore = require('connect-redis')(express);
var SessionSockets = require('session.socket.io');

exports.BongTalk = (function () {
    function BongTalk(servicePort) {
        this.servicePort = servicePort;
        this.sessionStore = new RedisStore({client:this.createRedisClient()});
        this.pub = this.createRedisClient();
        this.sub = this.createRedisClient();
        this.redisClient = this.createRedisClient();
    }

    BongTalk.prototype.start = function (){

        var cookieParser = express.cookieParser('your secret here');

        var app = express();
        app.set('port', process.env.PORT || this.servicePort);
        app.set('views', path.join(__dirname, 'views'));
        app.set('view engine', 'jade');
        app.use(express.favicon());
        app.use(express.logger('dev'));
        app.use(express.json());
        app.use(express.urlencoded());
        app.use(express.methodOverride());
        app.use(express.static(path.join(__dirname, 'public')));
        app.use(cookieParser);
        app.use(express.session({store: this.sessionStore, key: 'jsessionid', secret: 'your secret here'}));
        app.use(app.router);

// development only
        if ('development' === app.get('env')) {
            app.use(express.errorHandler());
        }

        app.get('/', routes.index);
        app.get('/users', user.list);
        app.get('/getCookie', function(req, res){
           res.send(req.cookies);
        });

        var server = http.createServer(app);

        var io = require('socket.io').listen(server);

        var sessionSockets = new SessionSockets(io, this.sessionStore, cookieParser, 'jsessionid');

        server.listen(app.get('port'), function () {
            util.log('Server listening on port ' + app.get('port'));
        });

        var models = require('./models');
        var User = models.User;
        var Zones = models.Zones;
        var zones = new Zones();



//        io.sockets.on('connection', function (socket) {
        sessionSockets.on('connection', function(err, socket, session){

//            util.log(util.inspect(err));
//            util.log(util.inspect(session));
            //create user
            var user = new User(socket, socket.id, session);

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

    BongTalk.prototype.createRedisClient = function(){
        var redisUrl = process.env.REDISTOGO_URL || 'redis://redistogo:40fcc23419a7cbcb0de7a0da111bda7b@albacore.redistogo.com:9125/';
        var rtg   = require("url").parse(redisUrl);
        var redisClient = redis.createClient(rtg.port, rtg.hostname);
        redisClient.auth(rtg.auth.split(":")[1]);

        return redisClient;
    };


    return BongTalk;
})();





