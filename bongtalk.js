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

var async = require('async');

var RedisDatabase = models.RedisDatabase;
var JadeDataBinder = models.JadeDataBinder;

var RedisStore = require('connect-redis')(express);
var Sockets = require('socket.io');
var SessionSockets = require('session.socket.io');

exports.BongTalk = (function () {
    function BongTalk(servicePort, redisUrl) {
        this.id = Guid.create().value;
        this.servicePort = servicePort;
        this.redisUrl = redisUrl;
        this.sessionStore = new RedisStore({client:this.createRedisClient(this.redisUrl)});
        this.pub = this.createRedisClient(this.redisUrl);
        this.sub = this.createRedisClient(this.redisUrl);
        this.redisClient = this.createRedisClient(this.redisUrl)
        this.database = new RedisDatabase(this.redisClient, this.id);
        this.connectedUsers = new Object();
    }

    BongTalk.prototype.start = function (){
        var _this = this;

        this.subscribeRedis();

        var cookieParser = express.cookieParser('your secret here');

        var app = express();
        app.set('port', process.env.PORT || this.servicePort); //포트설정
        app.set('views', path.join(__dirname, 'views')); //
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

        app.get('/', function(req, res){
            res.render('channel', { channel: 'default' });
        });

        var channelAlias = ['channel', 'ch', 'zone'];
        channelAlias.forEach(function(alias){app.get('/' + alias + '/:channel', function(req, res){
            res.render('channel', { channel: req.params.channel });
        });});
        channelAlias.forEach(function(alias){app.get('/' + alias, function(req, res){
            res.render('channel', { channel: 'default' });
        });});

        app.get('/status', function(req, res){
            var binder = new JadeDataBinder(_this);
            binder.loadData(function(){
                res.render('status', { binder: binder });
            });
        });

        app.get('/api/:api', function(req, res){
            _this.runApi(req, res);//.apply(_this, [req, res]);
        });


        var server = http.createServer(app);
        server.listen(app.get('port'), function () {
            util.log('Server listening on port ' + app.get('port'));
        });

        var io = Sockets.listen(server);
        io.set('log level', 2); // 0 - error  1 - warn  2 - info  3 - debug

        var sessionSockets = new SessionSockets(io, this.sessionStore, cookieParser, 'jsessionid');

        this.listenSocket(sessionSockets);
    };

    BongTalk.prototype.listenSocket = function(sessionSockets){
        var _this = this;
        sessionSockets.on('connection', function(err, socket, session){
            if (!session || !session.hasOwnProperty('id')){
                return;
            }

            var sessionHasId = (session && session.hasOwnProperty('userId'));
            var thisUser = new Object({
                id: sessionHasId? session.userId : Guid.create().value,
                channelId: (socket.handshake.query) ? socket.handshake.query.channelId : 'default',
                socket:socket,
                session:session.id
            });

            if (!sessionHasId){
                _this.sessionStore.get(session.id, function(err, result){
                    result.userId = thisUser.id;
                    _this.sessionStore.set(session.id, result);
                });
            }

            util.log("user '" + thisUser.id + "' connected");

            _this.database.getUserFromChannel(thisUser.channelId, thisUser.id, function(err, user){
                var profile = user;
                if (err){
                    profile = {id:thisUser.id};
                }
                socket.emit('sendProfile', profile);
            });

            socket.on('joinChannel', function(data) {
                util.log('joinChannel');
                async.parallel({
                    connectedUsers: function(callback){_this.database.getUsersFromChannel(data.channelId, callback);},
                    history: function(callback){_this.database.getTalkHistory(data.channelId, callback);}
                },
                function(err, result){
                    socket.emit('sendChannelInfo', result);
                    async.waterfall([
                        function(callback){
                            _this.database.addUserToChannel(data.channelId, data.user.id, data.user.name, callback);
                        },
                        function(result, callback){
                            _this.database.setUserOnline(thisUser.socket.id, data.channelId, data.user.id, callback)
                        },
                        function(result, callback){
                            _this.database.getUserConnections(thisUser.channelId, thisUser.id, callback);
                        },
                        function(connections, callback){
                            _this.changeAndPublishUserProperty(thisUser.channelId, thisUser.id, 'connections', connections);
                            callback(null);
                        },
                        function(callback){
                            _this.database.setUserName(data.channelId, data.user.id, data.user.name, callback);
                        },
                        function(result, callback){
                            _this.database.getUserFromChannel(data.channelId, data.user.id, callback);
                        }
                    ],
                    function(err, user){
                        if (!err){
                            thisUser.name = user.name;
                            _this.connectedUsers[socket.id] = thisUser;
                            _this.publishEventToChannel(data.channelId, 'newUser', user);
                        }
                    });
                });
            });

            socket.on('sendMessage', function(data){
                var talk = {
                    id: Guid.create().value,
                    time: (new Date()).getTime(),
                    message: data,
                    user: {
                        id : thisUser.id,
                        name: thisUser.name
                    }
                };
                _this.database.addTalkHistory(thisUser.channelId, talk);
                _this.publishEventToChannel(thisUser.channelId, 'sendMessage', talk);
            });

            socket.on('changeName', function(name){
                _this.changeAndPublishUserProperty(thisUser.channelId, thisUser.id, 'name', name, function(err){
                    if (!err){
                        thisUser.name = name;
                    }
                });
            });

            socket.on('disconnect', function(){
                var isLeaved = socket && socket.isLeaved;

                delete _this.connectedUsers[socket.id];

                if (!isLeaved) {
                    async.waterfall([
                        function(callback){
                            _this.database.setUserOffline(thisUser.socket.id, thisUser.channelId, thisUser.id, callback)
                        },
                        function(result, callback){
                            _this.database.getUserConnections(thisUser.channelId, thisUser.id, callback);
                        },
                        function(connections, callback){
                            _this.changeAndPublishUserProperty(thisUser.channelId, thisUser.id, 'connections', connections);
                            callback(null);
                        }
                    ]);
                }
            });

            socket.on('leaveChannel', function(){
                socket['isLeaved'] = true;
                _this.database.removeUserFromChannel(thisUser.channelId, thisUser.id, function(err){
                    if (!err){
                        _this.publishEventToChannel(thisUser.channelId, 'removeUser', {id:thisUser.id, name:thisUser.name});
                    }
                });
            });
        });
    }

    BongTalk.prototype.changeAndPublishUserProperty = function(channelId, userId, propertyName, propertyValue, callback){
        var _this = this;
        _this.database.setUserProperty(channelId, userId, propertyName, propertyValue, function(err, result){
            if (!err){
                _this.publishEventToChannel(channelId, 'userPropertyChanged', {user:{id:userId}, property:{name:propertyName, value:propertyValue}});
            }

            if (callback){
                callback(err, result);
            }
        });
    }

    BongTalk.prototype.publishEventToChannel = function(channelId, eventName, message){
        this.pub.publish('bongtalk:eventToChannel', JSON.stringify({channelId: channelId, eventName : eventName, message : message}));
    };

    BongTalk.prototype.publishEventToUser = function(channelId, userId, eventName, message){
        this.pub.publish('bongtalk:eventToUser', JSON.stringify({channelId:channelId, userId:userId, eventName : eventName, message : message}));
    };

    BongTalk.prototype.subscribeRedis = function(){
        var _this = this;

        this.sub.subscribe('bongtalk:eventToChannel');
        this.sub.subscribe('bongtalk:eventToUser');

        this.sub.on('message', function (channel, event){
            var eventObj = null;
            try{
                eventObj = JSON.parse(event);
            }catch (ex) {}

            switch (channel)
            {
                case "bongtalk:eventToChannel" :
                    for (var key in _this.connectedUsers){
                        var connection = _this.connectedUsers[key];
                        if (connection.channelId === eventObj.channelId){
                            connection.socket.emit(eventObj.eventName, eventObj.message);
                        }
                    }
                    break;
                case "bongtalk:eventToUser" :
                    for (var key in _this.connectedUsers){
                        var connection = _this.connectedUsers[key];
                        if (connection.channelId === eventObj.channelId && connection.id === eventObj.userId){
                            connection.socket.emit(eventObj.eventName, eventObj.message);
                            break;
                        }
                    }
                    break;
            }
        });
    };

    BongTalk.prototype.createRedisClient = function(redisUrl){
        if (redisUrl){
            var rtg   = require("url").parse(redisUrl);
            var redisClient = redis.createClient(rtg.port || 6379, rtg.hostname);
            if (rtg.auth)
            {
                var authString = rtg.auth;
                if (authString.indexOf(':') !== -1) {
                    authString = authString.split(":")[1];
                }

                redisClient.auth(authString);
            }

            return redisClient;
        }
        else{
            return redis.createClient();
        }
    };

    BongTalk.prototype.runApi = function(req, res){
        var _this = this;
        var method = req.params.api;
        var query = req.query;
        switch (method){
            case 'kick':
                if (query.channel && query.user){
                    async.waterfall([
                        function(callback){
                            _this.database.getUserName(query.channel, query.user, callback);
                        },
                        function(name, callback){
                            _this.database.removeUserFromChannel(query.channel,  query.user, function(err){
                                callback(err, name);
                            });
                        },
                        function(name, callback){
                            _this.publishEventToChannel(query.channel, 'removeUser', {id: query.user, name:name});
                            callback(null);
                        }
                    ],
                    function(err){
                        if (err){
                            res.send('err : ' + util.inspect(err));
                        }
                        else{
                            res.send('ok');
                        }
                    });
                }
                else{
                    res.send('fail');
                }
                break;
            default:
                res.send('Not exist api : ' + method);
        };
    };

    return BongTalk;
})();





