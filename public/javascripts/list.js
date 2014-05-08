'use strict';

define(['app', 'socket', 'underscore', 'modules/RequestResponseSocketClient'], function (app, io, _, RequestResponseSocketClient){
	app.controller('listCtrl', function($scope, $http){
		$scope.items = [
			{name:'beta', age : 1},
			{name:'alpha', age : 2}
		];
		// setInterval(function(){
		// 	// $scope.$apply(function(){
		// 		$scope.items.push({name:'aa', age:10});
		// 	// });

		// }, 1000)
		$scope.orderProp = 'age';
		$scope.serverStatus = 'before connect';
		$scope.createChannel = function(channel){
			reqClient.request('addUserToChannel', {channel:channel, name:'test'}, function(res){
				if (!res.err){
					var id = res.result;
					console.log(id);
				}
			});
		};

		$scope.updateChannelList = function(){
			reqClient.request('getAllChannel', {}, function(response){
				if (!response.err){
					var items = _.map(response.result, function(channelName){ return {name:channelName}; });
					$scope.$apply(function(){
						$scope.channels = items;
					});
				}
			});
		};

		$scope.joinChannel = function(channelId){
			alert(channelId);
		}

		var socket = io.connect('http://localhost:3000');
		var reqClient = new RequestResponseSocketClient(socket);
		socket.on('connect', function () {
			setServerStatusString('connected', 'success');
			$scope.updateChannelList();
		});
		socket.on('connecting', function () {setServerStatusString('connecting', 'info');});
		socket.on('disconnect', function () {setServerStatusString('disconnect', 'warning');});
		socket.on('connect_failed', function () {setServerStatusString('connect_failed', 'danger');});
		socket.on('error', function () {setServerStatusString('error', 'danger');});
		socket.on('message', function (message, callback) {setServerStatusString('message - ' + message);});
		socket.on('anything', function (data, callback) {setServerStatusString('anything - ' + data);});
		socket.on('reconnect_failed', function () {setServerStatusString('reconnect_failed', 'danger');});
		socket.on('reconnect', function () {setServerStatusString('reconnect', 'success');});
		socket.on('reconnecting', function () {setServerStatusString('reconnecting', 'info');});

		// label : default, primary, success, info, warning, danger
		function setServerStatusString(str, label){
			$scope.$apply(function(){
				console.log(str);
				$scope.serverStatus = str;
				$scope.serverStatusLabelClass = 'label label-' + (label || 'default');
			});
		}
	});
});
