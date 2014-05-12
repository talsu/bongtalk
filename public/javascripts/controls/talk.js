'use strict';

define(['controllers', 'socket', 'underscore', 'modules/RequestResponseSocketClient'], function (controllers, io, _, RequestResponseSocketClient){

	// var controllers = angular.module('appControllers', []);

	controllers.controller('talkCtrl', [ '$scope', '$routeParams', function($scope, $routeParams){
		$scope.channelId = $routeParams.channelId;
	}]);
});
