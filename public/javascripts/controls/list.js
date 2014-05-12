'use strict';

define(['controllers', 'underscore', 'modules/socketConnector'], function (controllers, _, connector){

	controllers.controller('listCtrl', function($scope, $http){
		$scope.orderProp = 'age';
		$scope.serverStatus = 'before connect';
		
		$scope.createChannel = function(channel){
			connector.request('addUserToChannel', {channel:channel, name:'test'}, function(res){
				if (!res.err){
					var id = res.result;
					console.log(id);
				}
			});
		};

		$scope.updateChannelList = function(){
			connector.request('getAllChannel', {}, function(response){
				if (!response.err){
					var items = _.map(response.result, function(channelName){ return {name:channelName}; });
					$scope.$apply(function(){
						$scope.channels = items;
					});
				}
			});
		};

		$scope.joinChannel = function(channelId){
			window.location = '#/ch/' + channelId;
		}

		connector.on('statusChanged', function(status){
			var level = 'info';

			switch(status){
				case 'connected' : level = 'success';
					$scope.updateChannelList();
				case 'reconnect' : level = 'success';
					break;
				case 'connecting' : level = 'info';
				case 'reconnecting' : level = 'info';
					break;
				case 'disconnect' : level = 'warning';
					break;
				case 'connect_failed' : level = 'danger';
				case 'reconnect_failed' : level = 'danger';
				case 'error' : level = 'danger';
					break;
			}

			setServerStatusString(status, level);
		});

		// connector.socket.on('connect', function () {
		// 	setServerStatusString('connected', 'success');
		// 	$scope.updateChannelList();
		// });
		// connector.socket.on('connecting', function () {setServerStatusString('connecting', 'info');});
		// connector.socket.on('disconnect', function () {setServerStatusString('disconnect', 'warning');});
		// connector.socket.on('connect_failed', function () {setServerStatusString('connect_failed', 'danger');});
		// connector.socket.on('error', function () {setServerStatusString('error', 'danger');});
		// connector.socket.on('message', function (message, callback) {setServerStatusString('message - ' + message);});
		// connector.socket.on('anything', function (data, callback) {setServerStatusString('anything - ' + data);});
		// connector.socket.on('reconnect_failed', function () {setServerStatusString('reconnect_failed', 'danger');});
		// connector.socket.on('reconnect', function () {setServerStatusString('reconnect', 'success');});
		// connector.socket.on('reconnecting', function () {setServerStatusString('reconnecting', 'info');});

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
