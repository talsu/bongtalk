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
var Guid = require('guid');
var models = require('./models');
var RedisZones = models.RedisZones;

var RedisStore = require('connect-redis')(express);
var SessionSockets = require('session.socket.io');

exports.BongTalk = (function () {
    function BongTalk(servicePort) {
        this.servicePort = servicePort;
        this.sessionStore = new RedisStore({client:this.createRedisClient()});
        this.pub = this.createRedisClient();
        this.sub = this.createRedisClient();
        this.redisClient = this.createRedisClient();

        this.redisZones = new RedisZones(this.redisClient);
        this.subscribeRedis();
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
        // reduce logging
        io.set('log level', 1);

        var sessionSockets = new SessionSockets(io, this.sessionStore, cookieParser, 'jsessionid');

        server.listen(app.get('port'), function () {
            util.log('Server listening on port ' + app.get('port'));
        });

        var User = models.User;
        var Zones = models.Zones;
        var zones = new Zones();
        var redisZones = this.redisZones;
        var pub = this.pub;
//        io.sockets.on('connection', function (socket) {
        sessionSockets.on('connection', function(err, socket, session){
            var thisUser = new Object({
                id:session.userId ? session.userId : Guid.create().value,
                socket:socket,
                session:session
            });

            util.log("user '" + thisUser.id + "' connected");
            redisZones.addUserSocket(thisUser.id, socket);
            redisZones.getOrCreateUser(thisUser.id, function (err, user){
                redisZones.addUser(user);
                util.log('sendProfile : ' + util.inspect(user));

                socket.emit('sendProfile', user);
            });

            socket.on('joinZone', function(data) {
                util.log('joinZone');
                redisZones.joinZone(data.zoneId, data.user.id, data.user.name, function(){
                    if (!err){
                        thisUser.currentZoneId = data.zoneId;
                        thisUser.name = data.user.name;
                        pub.publish('bongtalk:addUser', JSON.stringify( {zoneId: data.zoneId, userId : data.user.id}));
                    }
                });
            });

            socket.on('sendMessage', function(data){
//                if (user.currentZone) {
//                    user.currentZone.broadcastTalk(user, data);
//                }

                var talk = {
                    id:  Guid.create().value,
                    time: (new Date()).getTime(),
                    message: data,
                    user: {
                        id : thisUser.id,
                        name: thisUser.name
                    }
                };

                pub.publish('bongtalk:eventToZone', JSON.stringify({zoneId: thisUser.currentZoneId, eventName : 'sendMessage', message : talk}));
            });

            socket.on('changeName', function(name){
                redisZones.setUserField(thisUser.id, 'name', name, function(err, result){
                    if (!err){
                        thisUser.name = name
                        var message = {id:thisUser.id, name:thisUser.name};
                        pub.publish('bongtalk:changeName', JSON.stringify({zoneId: thisUser.currentZoneId, eventName : 'changeName', message : message}));
                    }
                });
            });

            socket.on('disconnect', function(){
                redisZones.leaveZone(thisUser.id, function(err, leavedZoneId){
                    if (!err){
                        pub.publish('bongtalk:removeUser', JSON.stringify( {zoneId: leavedZoneId, userId : thisUser.id}));
                    }
                });

                redisZones.removeUserSocket(thisUser.id);
            });
        });

        // subscribeRedis

    };

    BongTalk.prototype.createRedisClient = function(){
        var redisUrl = process.env.REDISTOGO_URL || 'redis://redistogo:40fcc23419a7cbcb0de7a0da111bda7b@albacore.redistogo.com:9125/';
        var rtg   = require("url").parse(redisUrl);
        var redisClient = redis.createClient(rtg.port, rtg.hostname);
        redisClient.auth(rtg.auth.split(":")[1]);

        return redisClient;
    };

    BongTalk.prototype.publishEventToZone = function(zoneId, eventName, message){
        this.pub.publish('bongtalk:eventToZone', {zoneId: zoneId, eventName : eventName, message : message});
    };

    BongTalk.prototype.publishEventToUser = function(zoneId, userId, eventName, message){
        this.pub.publish('bongtalk:eventToUser', JSON.stringify({zoneId:zoneId, userId:userId, eventName : eventName, message : message}));
    };

    BongTalk.prototype.subscribeRedis = function(){

        var _this = this;
//        this.sub.psubscribe('bongtalk:*');
        this.sub.subscribe('bongtalk:eventToZone');
        this.sub.subscribe('bongtalk:eventToUser');
        this.sub.subscribe('bongtalk:addUser');
        this.sub.subscribe('bongtalk:removeUser');
        this.sub.subscribe('bongtalk:changeName');


        var redisZones = this.redisZones;

        this.sub.on('message', function (channel, event){
            var eventObj = null;
            try{
                eventObj = JSON.parse(event);
            }catch (ex) {}

            switch (channel)
            {
                case "bongtalk:eventToZone" :
                    redisZones.eventToZone(eventObj);
                    break;
                case "bongtalk:eventToUser" :
                    redisZones.eventToUser(eventObj);
                    break;
                case "bongtalk:addUser" :
                    if (eventObj.zoneId && eventObj.userId && (redisZones.zones[eventObj.zoneId] || redisZones.notJoinedUsers[eventObj.userId])){
                        redisZones.getOrCreateUser(eventObj.userId, function(err, user){
                            if (!err){
                                //for exists User
                                redisZones.addUser(user);
                                //for new User
                                for (var userKey in redisZones.zones[user.currentZoneId].users){
                                    if (userKey !== user.id && redisZones.userSockets.hasOwnProperty(userKey)){
                                        var targetUser = redisZones.zones[user.currentZoneId].users[userKey];
                                        _this.publishEventToUser(user.currentZoneId, user.id, 'newUser', targetUser);
                                    }
                                }
                            }
                        });
                    }
                    break;
                case "bongtalk:removeUser" :
                    if (eventObj.zoneId && eventObj.userId && (redisZones.zones[eventObj.zoneId] || redisZones.notJoinedUsers[eventObj.userId])){
                        redisZones.removeUser(eventObj.zoneId, eventObj.userId);
                    }
                    break;
                case "bongtalk:changeName" :
                    redisZones.changeName(eventObj.zoneId, eventObj.message.id, eventObj.message.name);
                    redisZones.eventToZone(eventObj);
                    break;
            }
        });
    };

    return BongTalk;
})();





