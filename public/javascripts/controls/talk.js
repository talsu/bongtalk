'use strict';

define(['controllers', 'socket', 'underscore'], function (controllers, io, _){

	// var controllers = angular.module('appControllers', []);

	controllers.controller('talkCtrl', [ '$scope', '$routeParams', function($scope, $routeParams){
		$scope.channelId = $routeParams.channelId;
	}]);
});
